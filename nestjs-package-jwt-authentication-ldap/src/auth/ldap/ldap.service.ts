import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ldap from 'ldapjs';
import { Client } from 'ldapjs';
import { envConstants as e } from '../../common/constants/env';
import { filterator, getMemoryUsage, getMemoryUsageDifference, paginator, recordToArray } from '../../common/utils/util';
import { Cache } from './interfaces';
import { encodeAdPassword } from '../utils';
// tslint:disable-next-line: max-line-length
import { AddDeleteUserToGroupDto, ChangeUserRecordDto, CreateUserRecordDto, CacheResponseDto, SearchUserPaginatorResponseDto, SearchUserRecordDto, SearchUserRecordResponseDto, ChangeUserPasswordDto, SearchUserRecordsDto } from './dto';
import { ChangeUserRecordOperation, UpdateCacheOperation, UserAccountControl, UserObjectClass } from './enums';
import { CreateLdapUserModel } from './models';

/**
 * user model
 * https://bitbucket.org/criticallinksteam/c3/src/develop/src/backend/userModel.js
 */

@Injectable()
export class LdapService {
  private ldapClient: Client;
  private searchBase: string;
  private searchAttributes: string;
  private cache: Cache;

  constructor(
    private readonly configService: ConfigService,
  ) {
    // init ldapServer
    this.init(configService);
    // init cache object
    this.cache = {
      lastUpdate: undefined,
      totalUsers: undefined,
      elapsedTime: undefined,
      memoryUsage: undefined,
      status: undefined,
      users: {}
    };
  }

  // called by GqlLocalAuthGuard
  async init(configService: ConfigService): Promise<any> {
    const clientOptions: ldap.ClientOptions = {
      url: `ldap://${configService.get(e.LDAP_URL)}`,
      bindDN: this.configService.get(e.LDAP_BIND_DN),
      bindCredentials: configService.get(e.LDAP_BIND_CREDENTIALS),
    };
    // props
    this.searchBase = configService.get(e.LDAP_SEARCH_BASE);
    this.searchAttributes = configService.get(e.LDAP_SEARCH_ATTRIBUTES).toString().split(',');
    // create client
    this.ldapClient = ldap.createClient(clientOptions);
    // uncomment to test getUserRecord on init
    // const user = await this.getUserRecord('mario');
    // Logger.log(`user: [${JSON.stringify(user, undefined, 2)}]`, LdapService.name);
  }

  /**
   * helper method to update cache, on ldap changes
   * @param operation
   * @param username 
   */
  updateCachedUser(operation: UpdateCacheOperation, username: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        let key;
        // Logger.log(`UpdateCacheOperation operation: '${operation}'`, LdapService.name);
        switch (operation) {
          case UpdateCacheOperation.CREATE:
            // add user to cache, always get it from ldap to double check that it is inSync
            this.cache.users[username] = (await this.getUserRecord(username)).user;
            break;
          case UpdateCacheOperation.UPDATE:
            key = (Object.keys(this.cache.users) as Array<string>).find((key) => this.cache.users[key].username === username);
            // Logger.log(`this.cache.users[username]:${JSON.stringify(this.cache.users[key], undefined, 2)}`, LdapService.name)
            // update user in cache, always get it from ldap to double check that it is inSync
            this.cache.users[key] = (await this.getUserRecord(username)).user;
            break;
          case UpdateCacheOperation.DELETE:
            key = (Object.keys(this.cache.users) as Array<string>).find((key) => this.cache.users[key].username === username);
            // remove user from cache, we need a filteredUsers array helper
            const filteredUsers: Record<string, SearchUserRecordDto> = {};
            recordToArray(this.cache.users).forEach((e: SearchUserRecordDto) => {
              if (e.username != username) {
                // add to filteredUsers
                filteredUsers[e.username] = e;
              }
            });
            // update cached users without deleted user
            this.cache.users = filteredUsers;
            break;
          default:
            break;
        }
        // resolve promise
        resolve();
      } catch (error) {
        // reject promise
        reject(error);
      }
    })
  }

  getUserRecord = (username: string): Promise<SearchUserRecordResponseDto> => {
    return new Promise((resolve, reject) => {
      try {
        // let user: { username: string, dn: string, email: string, memberOf: string[], controls: string[] };
        let user: SearchUserRecordDto;
        // note to work we must use the scope sub else it won't work
        this.ldapClient.search(this.searchBase, { attributes: this.searchAttributes, scope: 'sub', filter: `(cn=${username})` }, (err, res) => {
          // this.ldapClient.search(this.searchBase, { filter: this.searchFilter, attributes: this.searchAttributes }, (err, res) => {
          if (err) Logger.log(err);
          res.on('searchEntry', (entry) => {
            // Logger.log(`entry.object: [${JSON.stringify(entry.object, undefined, 2)}]`);
            user = {
              // extract username from string | array
              dn: entry.object.dn as string,
              // if only have on group we must convert ldap string to array to ve consistent
              memberOf: (typeof entry.object.memberOf === 'string') ? [entry.object.memberOf] : entry.object.memberOf,
              controls: entry.object.controls as string[],
              objectCategory: entry.object.objectCategory as string,
              userAccountControl: entry.object.userAccountControl as string,
              lastLogonTimestamp: entry.object.lastLogonTimestamp as string,
              username: entry.object.cn as string,
              email: entry.object.userPrincipalName as string,
              displayName: entry.object.displayName as string,
              gender: entry.object.gender as string,
              mail: entry.object.mail as string,
              C3UserRole: entry.object.C3UserRole as string,
              dateOfBirth: entry.object.dateOfBirth as string,
              studentID: entry.object.studentID as string,
              telephoneNumber: entry.object.telephoneNumber as string,
            };
          });
          res.on('error', (error) => {
            throw error;
          });
          res.on('end', (result: ldap.LDAPResult) => {
            // Logger.log(`status: [${result.status}]`, LdapService.name);
            // responsePayload.result = result;
            // resolve promise
            user
              ? resolve({ user, status: result.status })
              : reject({ message: `user not found`, status: result.status });
          });
        });
      } catch (error) {
        // Logger.error(`error: [${error.message}]`, LdapService.name);
        // reject promise
        reject(error);
      }
    })
  };

  /**
   * init/update inMemory cache
   */
  // tslint:disable-next-line: max-line-length
  initUserRecordsCache = (
    filter: string = '(objectCategory=CN=Person,CN=Schema,CN=Configuration,DC=c3edu,DC=online)',
    pageSize: number = 1000
  ): Promise<CacheResponseDto> => {
    return new Promise((resolve, reject) => {
      try {
        // note to work we must use the scope sub else it won't work
        let user: SearchUserRecordDto;
        // countUsers sums on searchEntry event
        let countUsers = 0;
        // recordsFound sums on page event
        let recordsFound = 0;
        let currentPage = 0;
        // benchMark and memoryUsage
        const startTime = process.hrtime();
        const startMemoryUsage = getMemoryUsage();
        // start search by filter
        this.ldapClient.search(this.searchBase, {
          attributes: this.searchAttributes, scope: 'sub', filter,
          paged: {
            pageSize,
            pagePause: true
          },
        }, (err, res) => {
          if (err) Logger.error(err, LdapService.name);
          res.on('searchEntry', (entry) => {
            countUsers++;
            const dn = entry.object.dn as string;
            // Logger.log(`entry.object: [${JSON.stringify(entry.object, undefined, 2)}]`);
            // Logger.log(`entry.object: [${entry.object.dn}: ${countUsers}]`, LdapService.name);
            user = {
              // extract username from string | array
              dn,
              memberOf: (typeof entry.object.memberOf === 'string') ? [entry.object.memberOf] : entry.object.memberOf,
              controls: entry.object.controls as string[],
              objectCategory: entry.object.objectCategory as string,
              userAccountControl: entry.object.userAccountControl as string,
              lastLogonTimestamp: entry.object.lastLogonTimestamp as string,
              username: entry.object.cn as string,
              email: entry.object.userPrincipalName as string,
              displayName: entry.object.displayName as string,
              gender: entry.object.gender as string,
              mail: entry.object.mail as string,
              C3UserRole: entry.object.C3UserRole as string,
              dateOfBirth: entry.object.dateOfBirth as string,
              studentID: entry.object.studentID as string,
              telephoneNumber: entry.object.telephoneNumber as string,
            };
            // add user to inMemoryUsers with dn key
            this.cache.users[dn] = user;
          });
          res.on('page', (result, onPageCallback) => {
            // push to pages
            currentPage++;
            // assign only if null
            if (!recordsFound && result.controls && result.controls[0]) { recordsFound = result.controls[0]._value.size };
            // NOTE: debug stuff: leave it here for future development
            const totalPageRecords = (result.controls && result.controls[0]) ? result.controls[0]._value.cookie[0] >= 0 : null;
            // const {_value: {size: recordsSize} } = (result.controls as any);
            // Logger.log(`page end result.controls: ${JSON.stringify(result.controls, undefined, 2)}`, LdapService.name);
            // tslint:disable-next-line: max-line-length
            // Logger.log(`page end event: currentPage: '${currentPage}', recordsFound: '${recordsFound}', totalPageRecords: '${totalPageRecords}'`, LdapService.name);
            // use the page event to continue with next page if the sizeLimit (of page) is reached.
            // tslint:disable-next-line: max-line-length
            // call the callBack requesting more pages, this will continue to search, only call if onPageCallback is not null, when arrives last page it will be null
            if (onPageCallback) { onPageCallback(); };
          });
          res.on('error', (error) => {
            reject(error);
          });
          res.on('end', (result: ldap.LDAPResult) => {
            // benchMark and memoryUsage
            const parseHrtimeToSeconds = (hrtime) => {
              const seconds = (hrtime[0] + (hrtime[1] / 1e9)).toFixed(3);
              return seconds;
            }
            const elapsedTime = parseHrtimeToSeconds(process.hrtime(startTime));
            const endMemoryUsage = getMemoryUsage();
            const cacheMemoryUsage = getMemoryUsageDifference(startMemoryUsage, endMemoryUsage);
            const cachedUsersLength = Object.keys(this.cache.users).length;
            if (cachedUsersLength > 0 && Array.isArray(Object.values(this.cache.users))) {
              // update cache object
              // tslint:disable-next-line: max-line-length
              this.cache = { ...this.cache, lastUpdate: Date.now(), totalUsers: recordsFound, elapsedTime, status: result.status, memoryUsage: { cache: cacheMemoryUsage, system: endMemoryUsage } };
              // get paginatorResult: used for debug purposes only
              // const paginatorResult = paginator(Object.values(this.cache.users), 1, 100);
              // Logger.log(`paginatorResult: [${JSON.stringify(paginatorResult, undefined, 2)}]`);
              // resolve promise
              resolve({
                lastUpdate: this.cache.lastUpdate,
                totalUsers: this.cache.totalUsers,
                elapsedTime: this.cache.elapsedTime,
                memoryUsage: this.cache.memoryUsage,
                status: this.cache.status
              });
            } else {
              reject({ message: `records not found, cached not initialized`, status: result.status });
            }
          });
        });
      } catch (error) {
        // Logger.error(`error: [${error.message}]`, LdapService.name);
        // reject promise
        reject(error);
      }
    })
  };

  /**
   * pagination version
   */
  getUserRecords = (searchUserRecordsDto: SearchUserRecordsDto): Promise<SearchUserPaginatorResponseDto> => {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.cache.lastUpdate) {
          throw new Error('cache not yet initialized! first initialize cache and try again');
        } else {
          // convert record to array before duty
          const recordArray = recordToArray(this.cache.users);
          const filtered = await filterator(recordArray, searchUserRecordsDto.searchAttributes);
          const paginatorResult = await paginator(filtered, searchUserRecordsDto.page, searchUserRecordsDto.perPage);
          resolve({ ...paginatorResult });
        }
      } catch (error) {
        // Logger.error(`error: [${error.message}]`, LdapService.name);
        // reject promise
        reject(error);
      }
    })
  };

  createUserRecord(createLdapUserDto: CreateUserRecordDto): Promise<void> {
    return new Promise((resolve, reject) => {
      // outside of try, catch must have access to entry object
      // const defaultNamePostfix = this.configService.get(e.LDAP_SEARCH_ATTRIBUTES);
      // const cn = `${createLdapUserDto.firstName} ${createLdapUserDto.lastName}`;
      const cn = createLdapUserDto.username;
      const newUser: CreateLdapUserModel = {
        cn,
        name: createLdapUserDto.username,
        givenname: createLdapUserDto.firstName,
        sn: createLdapUserDto.lastName,
        // tslint:disable-next-line: max-line-length
        displayName: (createLdapUserDto.displayName) ? createLdapUserDto.displayName : `${createLdapUserDto.firstName} ${createLdapUserDto.firstName}`,
        // class that has custom attributes ex "objectClass": "User"
        objectclass: createLdapUserDto.objectClass ? createLdapUserDto.objectClass : UserObjectClass.USER,
        unicodePwd: encodeAdPassword(createLdapUserDto.password),
        sAMAccountName: createLdapUserDto.username,
        userAccountControl: UserAccountControl.NORMAL_ACCOUNT,
        // optionals
        mail: createLdapUserDto.mail,
        dateOfBirth: createLdapUserDto.dateOfBirth,
        gender: createLdapUserDto.gender,
        telephoneNumber: createLdapUserDto.telephoneNumber,
        studentID: createLdapUserDto.studentID,
      };

      try {
        const newDN = `cn=${cn},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
        this.ldapClient.add(newDN, newUser, async (error) => {
          if (error) {
            reject(error);
          } else {
            // must add new user to group
            await this.addDeleteUserToGroup(ChangeUserRecordOperation.ADD, { username: newUser.cn, group: 'c3student' });
            // update cache
            await this.updateCachedUser(UpdateCacheOperation.CREATE, cn);
            resolve();
          }
        });
      } catch (error) {
        // const message = (error && error.name === 'InvalidDistinguishedNameError')
        //   ? { message: parseTemplate(c.INVALID_DISTINGUISHED_NAME_ERROR, createLdapUserDto), newUser }
        //   : error;
        reject(error);
      }
    });
  };

  /**
   * add group/role to user
   */
  addDeleteUserToGroup(operation: ChangeUserRecordOperation, addUserToGroupDto: AddDeleteUserToGroupDto): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const groupDN = `cn=${addUserToGroupDto.group},ou=Groups,dc=c3edu,dc=online`;
        const groupChange = new ldap.Change({
          operation,
          modification: {
            member: `cn=${addUserToGroupDto.username},ou=C3Student,ou=People,dc=c3edu,dc=online`
          }
        });
        this.ldapClient.modify(groupDN, groupChange, async (error) => {
          if (error) {
            reject(error);
          } else {
            // update cache
            await this.updateCachedUser(UpdateCacheOperation.UPDATE, addUserToGroupDto.username);
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  /**
   * delete user
   */
  deleteUserRecord(username: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const delDN = `cn=${username},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
      try {
        this.ldapClient.del(delDN, async (error) => {
          if (error) {
            reject(error);
          } else {
            // update cache
            await this.updateCachedUser(UpdateCacheOperation.DELETE, username);
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  /**
   * change user record
   */
  changeUserRecord(username: string, changeUserRecordDto: ChangeUserRecordDto): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const changeDN = `cn=${username},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
        // map array of changes to ldap.Change
        const changes = changeUserRecordDto.changes.map((change: ldap.Change) => {
          return new ldap.Change({
            operation: change.operation,
            modification: change.modification
          });
        });

        this.ldapClient.modify(changeDN, changes, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  /**
   * change user password
   */
  changeUserProfilePassword(username: string, changeUserPasswordDto: ChangeUserPasswordDto): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const changeDN = `cn=${username},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
        if (!changeUserPasswordDto.oldPassword || !changeUserPasswordDto.newPassword) {
          throw new Error('you must pass a valid oldPassword and newPassword properties')
        }
        if (changeUserPasswordDto.oldPassword === changeUserPasswordDto.newPassword) {
          throw new Error('oldPassword and newPassword are equal')
        }
        // map array of changes to ldap.Change
        const changes = [
          new ldap.Change({
            operation: 'delete',
            modification: {
              unicodePwd: encodeAdPassword(changeUserPasswordDto.oldPassword)
            }
          }),
          new ldap.Change({
            operation: 'add',
            modification: {
              unicodePwd: encodeAdPassword(changeUserPasswordDto.newPassword)
            }
          })
        ];
        this.ldapClient.modify(changeDN, changes, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  // STUB promise template
  // createUserRecord(createLdapUserDto: CreateLdapUserDto): Promise<any> {
  //   return new Promise((resolve, reject) => {
  //     try {
  //       resolve();
  //     } catch (error) {
  //       reject(error);
  //     }
  //   });
  // };
}

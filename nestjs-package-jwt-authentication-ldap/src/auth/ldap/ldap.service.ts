import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ldap from 'ldapjs';
import { Client } from 'ldapjs';
import { envConstants as e } from '../../common/constants/env';
import { encodeAdPassword } from '../utils';
import { AddUserToGroupDto, ChangeUserRecordDto, CreateUserRecordDto, SearchUserRecordDto, SearchUserRecordResponseDto } from './dto';
import { UserAccountControl, UserObjectClass } from './enums';
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
  // TODO
  private searchPagePause: boolean;

  constructor(
    private readonly configService: ConfigService,
  ) {
    // init ldapServer
    this.init(configService);
    // TODO
    this.searchPagePause = true;
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

  getUserRecord = (username: string): Promise<SearchUserRecordResponseDto> => {
    return new Promise((resolve, reject) => {
      try {
        // let user: { username: string, dn: string, email: string, memberOf: string[], controls: string[] };
        let user: SearchUserRecordDto;
        // note to work we must use the scope sub else it won't work
// TODO
let users: SearchUserRecordDto[] = [];
// const pageSize = 1;
let countUsers = 0;
// const filter = `(cn=${username})`;
const filter = `(objectCategory=CN=Person,CN=Schema,CN=Configuration,DC=c3edu,DC=online)`;
// const paged: {pageSize: number, pagePause: boolean} = {
//   pageSize,
//   pagePause: true
// };
        this.ldapClient.search(this.searchBase, { attributes: this.searchAttributes, scope: 'sub', filter,
        // paged: true,
        // sizeLimit: 200
        paged: {
          pageSize: 50,
          pagePause: true
        },
       }, (err, res) => {
          // this.ldapClient.search(this.searchBase, { filter: this.searchFilter, attributes: this.searchAttributes }, (err, res) => {
          if (err) Logger.error(err, LdapService.name);
          res.on('searchEntry', (entry) => {
// TODO
countUsers++;
// Logger.log(`entry.object: [${JSON.stringify(entry.object, undefined, 2)}]`);
Logger.log(`entry.object: [${entry.object.dn}: ${countUsers}]`, LdapService.name);
            user = {
              // extract username from string | array
              dn: entry.object.dn as string,
              memberOf: entry.object.memberOf as string[],
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
// TODO
users.push(user);
          });
          res.on('page', (result) => {
Logger.log('page end', LdapService.name);
users.length > 0
// users.length > 0
  // TODO use user or users
  ? resolve({ user, users, status: result.status })
  // ? resolve({ user, users, status: result.status })
  : reject({ message: `user not found`, status: result.status });
          });
          res.on('error', (error) => {
            throw error;
          });
          res.on('end', (result: ldap.LDAPResult) => {
            // Logger.log(`status: [${result.status}]`, LdapService.name);
            // responsePayload.result = result;
            // resolve promise
debugger;
users.length > 0
// users.length > 0
  // TODO use user or users
  ? resolve({ user, users, status: result.status })
  // ? resolve({ user, users, status: result.status })
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
            await this.addUserToGroup({ username: newUser.cn, group: 'c3student' });
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
   * @param memberDN
   */
  addUserToGroup(addUserToGroupDto: AddUserToGroupDto): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const groupDN = `cn=${addUserToGroupDto.group},ou=Groups,dc=c3edu,dc=online`;
        const groupChange = new ldap.Change({
          operation: 'add',
          modification: {
            member: `cn=${addUserToGroupDto.username},ou=C3Student,ou=People,dc=c3edu,dc=online`
          }
        });
        this.ldapClient.modify(groupDN, groupChange, (error) => {
          if (error) {
            throw (error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  deleteUserRecord(username: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const delDN = `cn=${username},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
      try {
        this.ldapClient.del(delDN, async (error) => {
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
   * change user record
   * @param memberDN
   */
  changeUserRecord(username: string, changeUserRecordDto: ChangeUserRecordDto): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const changeDN = `cn=${username},${this.configService.get(e.LDAP_NEW_USER_DN_POSTFIX)},${this.configService.get(e.LDAP_BASE_DN)}`;
        // map array of changes to ldap.Change
        const changes = changeUserRecordDto.map((change: ldap.Change) => {
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

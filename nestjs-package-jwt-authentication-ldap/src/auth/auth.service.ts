import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { SignOptions } from 'jsonwebtoken';
import { envConstants } from '../common/constants/env';
import AccessToken from './interfaces/access-token.interface';
import { JwtResponsePayload } from './interfaces/jwt-response-payload.interface';
import { hashPassword } from './utils/util';
import { AuthStore } from './auth.store';
// import { LdapService } from './ldap/ldap.service';

@Injectable()
export class AuthService {
  // init usersStore
  usersStore: AuthStore = new AuthStore(this.configService);

  constructor(
    private readonly configService: ConfigService,
    // private readonly ldapService: LdapService,
    private readonly jwtService: JwtService,
  ) { }
  // called by GqlLocalAuthGuard
  // async validateUser(username: string, pass: string): Promise<any> {
  //   // TODO
  //   // const user = await this.usersService.findOneByUsername(username);
  //   debugger;
  //   // const user = await this.ldapService.getUserRecord(username);
  //   // TODO wip
  //   console.log('WIP');
  //   // if (user) {
  //   //   const authorized = this.bcryptValidate(pass, user.password);
  //   //   if (authorized) {
  //   //     // this will remove password from result leaving all the other properties
  //   //     const { password, ...result } = user;
  //   //     // we could do a database lookup in our validate() method to extract more information about the user,
  //   //     // resulting in a more enriched user object being available in our Request
  //   //     return result;
  //   //   }
  //   // }
  //   return null;
  // }

  async signJwtToken(user: any, options?: SignOptions): Promise<AccessToken> {
    // note: we choose a property name of sub to hold our userId value to be consistent with JWT standards
    const payload = { username: user.username, sub: user.userId, roles: user.roles };
    return {
      // generate JWT from a subset of the user object properties
      accessToken: this.jwtService.sign(payload, options),
    };
  }

  async signRefreshToken(user: any, tokenVersion: number, options?: SignOptions): Promise<AccessToken> {
    const payload = { username: user.username, sub: user.userId, roles: user.roles, tokenVersion };
    return {
      // generate JWT from a subset of the user object properties
      accessToken: this.jwtService.sign(payload, {
        ...options,
        // require to use refreshTokenJwtSecret
        secret: this.configService.get(envConstants.REFRESH_TOKEN_JWT_SECRET),
        expiresIn: this.configService.get(envConstants.REFRESH_TOKEN_EXPIRES_IN),
      }),
    };
  }

  sendRefreshToken(res: Response, { accessToken }: AccessToken): void {
    res.cookie('jid', accessToken, {
      // prevent javascript access
      httpOnly: true,
    });
  }

  getJwtPayLoad(token: string): JwtResponsePayload {
    return this.jwtService.verify(token);
  }

  // tslint:disable-next-line: no-shadowed-variable
  bcryptValidate(password: string, hashPassword: string): boolean {
    return bcrypt.compareSync(password, hashPassword);
  }

  hashPassword(password: string): string {
    return hashPassword(password);
  }

  getRolesFromMemberOf(memberOf: string[]): string[] {
    if (memberOf.length < 0) {
      return [];
    }
    const roles: string[] = memberOf.map((e: string) => {
      const memberOfRole: string[] = e.split(',');
      // get first group, and only add c3 prefixed roles
      return (memberOfRole[0].includes('='))
        ? memberOfRole[0].split('=')[1].replace('C3','C3_').replace(' ','_').toUpperCase()
        : undefined
    });
    return roles;
  }
}

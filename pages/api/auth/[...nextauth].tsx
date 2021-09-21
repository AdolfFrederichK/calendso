import NextAuth from "next-auth";
import Providers from "next-auth/providers";
import prisma from "@lib/prisma";
import { ErrorCode, Session, verifyPassword } from "@lib/auth";
import { authenticator } from "otplib";
import { symmetricDecrypt } from "@lib/crypto";

export default NextAuth({
  session: {
    jwt: true,
  },
  pages: {
    signIn: "/auth/login",
    signOut: "/auth/logout",
    error: "/auth/error", // Error code passed in query string as ?error=
  },
  providers: [
    Providers.Credentials({
      name: "Cal.com",
      credentials: {
        email: { label: "Email Address", type: "email", placeholder: "john.doe@example.com" },
        password: { label: "Password", type: "password", placeholder: "Your super secure password" },
        totpCode: { label: "Two-factor Code", type: "input", placeholder: "Code from authenticator app" },
      },
      async authorize(credentials) {
        const user = await prisma.user.findUnique({
          where: {
            email: credentials.email,
          },
        });

        if (!user) {
          throw new Error(ErrorCode.UserNotFound);
        }

        if (!user.password) {
          throw new Error(ErrorCode.UserMissingPassword);
        }

        const isCorrectPassword = await verifyPassword(credentials.password, user.password);
        if (!isCorrectPassword) {
          throw new Error(ErrorCode.IncorrectPassword);
        }

        if (user.twoFactorEnabled) {
          if (!credentials.totpCode) {
            throw new Error(ErrorCode.SecondFactorRequired);
          }

          if (!user.twoFactorSecret) {
            console.error(`Two factor is enabled for user ${user.id} but they have no secret`);
            throw new Error(ErrorCode.InternalServerError);
          }

          if (!process.env.CALENDSO_ENCRYPTION_KEY) {
            console.error(`"Missing encryption key; cannot proceed with two factor login."`);
            throw new Error(ErrorCode.InternalServerError);
          }

          const secret = symmetricDecrypt(user.twoFactorSecret, process.env.CALENDSO_ENCRYPTION_KEY);
          if (secret.length !== 32) {
            console.error(
              `Two factor secret decryption failed. Expected key with length 32 but got ${secret.length}`
            );
            throw new Error(ErrorCode.InternalServerError);
          }

          const isValidToken = authenticator.check(credentials.totpCode, secret);
          if (!isValidToken) {
            throw new Error(ErrorCode.IncorrectTwoFactorCode);
          }
        }

        return {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          locale: user.locale,
        };
      },
    }),
  ],
  callbacks: {
    async jwt(token, user) {
      // If we update the user username/locale
      // the token is not updated with the
      // updated username/locale (only after signing in again)
      // If session exists, update with the right value
      if (!user && token.id) {
        const currentUser = await prisma.user.findUnique({
          where: {
            id: token.id,
          },
        });
        if (currentUser) {
          token.id = currentUser.id;
          token.username = currentUser.username;
          token.locale = currentUser.locale;
        }
      }

      if (user) {
        token.id = user.id;
        token.username = user.username;
        token.locale = user.locale;
      }
      return token;
    },
    async session(session, token) {
      const calendsoSession: Session = {
        ...session,
        user: {
          ...session.user,
          id: token.id as number,
          username: token.username as string,
          locale: token.locale as string,
        },
      };
      return calendsoSession;
    },
  },
});

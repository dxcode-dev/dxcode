import type { UserId } from "@dx/domain";
import * as React from "react";

export interface SignedInIdentity {
  readonly id: UserId;
  readonly name: string;
  readonly email: string;
}

export interface AuthContextValue {
  readonly identity: SignedInIdentity;
  readonly logout: () => void;
}

export const AuthContext = React.createContext<AuthContextValue | undefined>(
  undefined,
);

export const useIdentity = () => React.useContext(AuthContext);

export const useAuthenticatedIdentity = () => {
  const value = React.useContext(AuthContext);
  if (value === undefined)
    throw new Error("useAuthenticatedIdentity requires an authenticated user.");
  return value;
};

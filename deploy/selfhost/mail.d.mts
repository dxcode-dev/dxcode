/** Why a mail domain cannot work, or undefined when it can. */
export declare const mailDomainProblem: (domain: string) => string | undefined;

/** The trade-offs of giving dx this domain's mail, as deploy summary lines. */
export declare const mailDomainTradeoffs: (input: {
  readonly domain: string;
  readonly appHostname?: string;
}) => ReadonlyArray<string>;

export declare const MAIL_PERMISSIONS: ReadonlyArray<{
  readonly label: string;
  readonly scope: string;
}>;
export declare const MAIL_OAUTH_SCOPES: ReadonlyArray<string>;

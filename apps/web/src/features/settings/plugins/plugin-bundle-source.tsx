import type { PluginBundleData, PluginSignatureData } from "@dx/api";
import { FileArchive, FolderGit2, Link2, ShieldCheck } from "lucide-react";
import { sourceLabel } from "./plugin-bundle-presentation.js";

/** Who signed it, as far as dx can prove. */
const signedBy = ({ signer, fingerprint }: PluginSignatureData) =>
  signer.kind === "you"
    ? "Signed by you"
    : signer.kind === "publisher"
      ? `Signed by ${signer.domain}`
      : `Signed by ${fingerprint.slice(0, 15)}…`;

/**
 * Where a bundle came from, the version it declares, and its verified
 * signature, in one line.
 */
export function PluginBundleSourceLine({
  source,
  version,
  signature,
}: {
  readonly source: PluginBundleData["source"];
  readonly version?: string | undefined;
  readonly signature?: PluginSignatureData | undefined;
}) {
  return (
    <p className="plugin-bundle-source-line">
      {source.type === "zip" ? (
        <FileArchive aria-hidden="true" />
      ) : source.type === "share" ? (
        <Link2 aria-hidden="true" />
      ) : (
        <FolderGit2 aria-hidden="true" />
      )}
      <span title={sourceLabel(source)}>{sourceLabel(source)}</span>
      {version === undefined ? null : <span>v{version}</span>}
      {signature === undefined ? null : (
        <span
          className="plugin-bundle-signature"
          data-signer={signature.signer.kind}
          title={`${signature.fingerprint}\n${signature.publicKey}`}
        >
          <ShieldCheck aria-hidden="true" />
          {signedBy(signature)}
        </span>
      )}
    </p>
  );
}

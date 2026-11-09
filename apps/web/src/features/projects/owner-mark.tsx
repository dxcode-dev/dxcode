import { Building2, UserRound } from "lucide-react";

/**
 * A project owner's picture: the person's avatar for personal projects, the
 * workspace's for workspace projects, or an icon when there is none.
 */
export function OwnerMark({
  personal,
  image,
}: {
  readonly personal: boolean;
  readonly image?: string;
}) {
  return (
    <span className={`owner-mark ${personal ? "personal" : ""}`}>
      {image !== undefined ? (
        <img src={image} alt="" referrerPolicy="no-referrer" />
      ) : personal ? (
        <UserRound />
      ) : (
        <Building2 />
      )}
    </span>
  );
}

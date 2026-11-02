import { CircleAlert, CircleCheck, MessageCircleQuestion } from "lucide-react";

/** Each Needs-you kind's icon and name, for the popover and the page. */
export const NEEDS_YOU_KIND = {
  question: { icon: MessageCircleQuestion, label: "Question" },
  approval: { icon: CircleCheck, label: "Approval" },
  failed: { icon: CircleAlert, label: "Failed" },
} as const;

import type { BugReportData } from "@dx/api";

export const statusText = (report: BugReportData) => {
  switch (report.status) {
    case "filing":
      return "Filing…";
    case "filed":
      return `Filed as #${report.issue?.number}`;
    case "commented":
      return `Added to #${report.issue?.number}`;
    case "saved":
      return "Saved";
    case "failed":
      return "Not filed";
  }
};

export const firstLine = (message: string) =>
  message.split("\n").find((line) => line.trim() !== "") ?? message;

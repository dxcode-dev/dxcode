import DASHBOARD_HTML from "./dashboard.html.js";

const deploys = [
  {
    version: "2.3.9",
    status: "canary",
    author: "maya",
    duration: "6m 02s",
    when: "4 min ago",
  },
  {
    version: "2.3.8",
    status: "live",
    author: "ravi",
    duration: "5m 41s",
    when: "2 h ago",
  },
  {
    version: "2.3.7",
    status: "rolled back",
    author: "jun",
    duration: "7m 15s",
    when: "Yesterday",
  },
  {
    version: "2.3.6",
    status: "live",
    author: "maya",
    duration: "5m 12s",
    when: "Mon",
  },
  {
    version: "2.3.5",
    status: "live",
    author: "alex",
    duration: "4m 58s",
    when: "Mon",
  },
];

/** @param {import("@dxcode/plugin").PluginAPI} dx */
export default function (dx) {
  dx.registerPane({
    id: "dashboard",
    title: "Releases",
    html: DASHBOARD_HTML,
    onMessage: async (message) => {
      if (message?.action === "ship")
        return {
          deploys: [
            {
              version: "2.4.0",
              status: "queued",
              author: "you",
              duration: "—",
              when: "now",
            },
            ...deploys,
          ],
          status: { tone: "info", text: "Shipping 2.4.0" },
        };
      if (message?.action === "save") return { saved: true };
      return { deploys, status: { tone: "success", text: "Healthy" } };
    },
  });
}

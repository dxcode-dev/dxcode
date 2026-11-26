/** The short name people type: `grafana` for `com.example.grafana`. */
export const draftShortName = (name: string) => name.split(".").at(-1) ?? name;

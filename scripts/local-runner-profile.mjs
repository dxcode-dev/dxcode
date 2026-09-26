export const localRunnerProfileCatalog = () =>
  JSON.stringify({
    version: 1,
    defaultProfileId: "local-default",
    profiles: [
      {
        id: "local-default",
        label: "Local workspace",
        adapter: "local",
        resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
        isolation: "process",
        availability: "available",
        costLabel: "Local · no provider billing",
        capabilities: ["git", "environment-variables", "persistent-workspace"],
      },
    ],
  });

export const localDevVarValue = (value) => {
  if (value.includes("'") || /[\r\n]/.test(value))
    throw new Error("Generated local binding cannot be encoded safely.");
  return `'${value}'`;
};

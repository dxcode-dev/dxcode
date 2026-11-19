import { Cpu } from "lucide-react";
import { modelProvider } from "../../shared/model-provider.js";
import { ProviderMark } from "../../shared/ui/provider-marks.js";

/**
 * A model's maker's logo, or a chip for a maker without one. Loaded after
 * the Thread page's first paint: the logos are most of its weight.
 */
export function ThreadModelMark({
  model,
  name,
}: {
  readonly model: string;
  readonly name: string;
}) {
  return (
    <ProviderMark
      providerId={modelProvider(model, name).id}
      fallback={<Cpu aria-hidden="true" />}
    />
  );
}

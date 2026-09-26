import { type EffectCallback, useEffect, useState } from "react";

export const useMountEffect = (effect: EffectCallback) => {
  // Capture the setup for this mount; rerenders must not replace its resource.
  const [setup] = useState(() => effect);
  useEffect(setup, [setup]);
};

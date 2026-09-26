const MODEL_WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  claude: "Claude",
  terra: "Terra",
  sol: "Sol",
  astra: "Astra",
  fable: "Fable",
  luna: "Luna",
  opus: "Opus",
  sonnet: "Sonnet",
};
export function modelDisplayName(name: string): string {
  const short = name.split("/").at(-1) ?? name;
  if (short.includes(" ")) return short;
  return short
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split("-")
    .map((word) => MODEL_WORDS[word.toLowerCase()] ?? word)
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

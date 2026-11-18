import { codeSampleEdit, codeSampleReply } from "./code-sample-source.js";
import { EditDiff } from "./edit-diff.js";
import { RichMarkdown } from "./rich-markdown.js";

/**
 * Code as dx shows it: a reply's code block (highlight.js) and an edit diff
 * (the diff library), the two ways code is drawn. Both read the code tokens,
 * so they show what a Code Font or palette change does everywhere.
 */
export function CodeSamples() {
  return (
    <div className="code-samples">
      <RichMarkdown>{codeSampleReply}</RichMarkdown>
      <EditDiff source={codeSampleEdit} />
    </div>
  );
}

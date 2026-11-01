/**
 * Names the browser tab "<name> - dx" while this renders. React 19 hoists the
 * element into the document head ahead of index.html's "dx", which the tab
 * shows again once the page unmounts.
 */
export function DocumentTitle({ name }: { readonly name: string }) {
  return <title>{`${name} - dx`}</title>;
}

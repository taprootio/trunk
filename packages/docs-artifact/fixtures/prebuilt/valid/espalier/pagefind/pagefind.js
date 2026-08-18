export async function search(term) {
  const response = await fetch("/pagefind/index/abc.pf_index");
  return { term, bytes: (await response.arrayBuffer()).byteLength };
}

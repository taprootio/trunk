self.onmessage = ({ data }) => self.postMessage({ query: data.query, matches: [] });

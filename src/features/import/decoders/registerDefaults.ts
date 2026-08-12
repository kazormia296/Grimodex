import { registerImportDecoder } from "./registryStorage";
import { textDecoder } from "./textDecoder";
import { markdownDecoder } from "./markdownDecoder";
import { jsonDecoder } from "./jsonDecoder";
import { delimitedTextDecoder } from "./delimitedTextDecoder";
import { htmlDecoder } from "./htmlDecoder";

/** Side-effect module: registers built-in decoders once. */
export function registerDefaultImportDecodersImpl(): void {
  registerImportDecoder(textDecoder);
  registerImportDecoder(markdownDecoder);
  registerImportDecoder(jsonDecoder);
  registerImportDecoder(delimitedTextDecoder);
  registerImportDecoder(htmlDecoder);
}

registerDefaultImportDecodersImpl();

// SP-N の変異の load hook を登録する（node --import <this>）。
import { register } from "node:module";
register(new URL("./hook.mjs", import.meta.url));

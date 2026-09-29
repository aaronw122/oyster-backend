import type { Builtin } from "../sources/builtins.ts";
import { mta } from "./mta.ts";

// Each built-in adds one import and one entry here.
export const BUILTINS: Builtin[] = [mta];

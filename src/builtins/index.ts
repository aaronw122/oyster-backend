import type { Builtin } from "../sources/builtins.ts";
import { markets } from "./markets.ts";

// Each built-in adds one import and one entry here.
export const BUILTINS: Builtin[] = [markets];

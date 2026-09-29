import type { Builtin } from "../sources/builtins.ts";
import { gbfs } from "./gbfs.ts";
import { markets } from "./markets.ts";
import { mta } from "./mta.ts";
import { recurse } from "./recurse.ts";
import { weather } from "./weather.ts";

// Each built-in adds one import and one entry here.
export const BUILTINS: Builtin[] = [gbfs, weather, mta, markets, recurse];

import { SIZE_BUDGETS, SIZES, type Size, type WidgetOutput } from "../contract/index.ts";

export type FitResult = { ok: true; output: WidgetOutput } | { ok: false; errors: string[] };

/** §2b per-size projection: drop fields the size doesn't show, cut `items` to the cap (first N). */
export function projectForSize(output: WidgetOutput, size: Size): WidgetOutput {
  const budget = SIZE_BUDGETS[size];
  const projected: WidgetOutput = { value: output.value };
  if (budget.subtitle !== null && output.subtitle !== undefined) projected.subtitle = output.subtitle;
  if (budget.items !== null && output.items !== undefined) {
    projected.items = output.items.slice(0, budget.items.max).map((item) => ({ ...item }));
  }
  return projected;
}

/** Projects `output` for `size`, then enforces the §2b code-point budgets. */
export function fitToSize(output: WidgetOutput, size: Size): FitResult {
  const budget = SIZE_BUDGETS[size];
  const projected = projectForSize(output, size);
  const errors: string[] = [];
  const check = (field: string, text: string, max: number) => {
    let length = 0; // Unicode code points, not UTF-16 units
    for (const _ of text) length++;
    if (length > max) errors.push(`${size}: ${field} is ${length} code points (max ${max})`);
  };

  if (projected.value.length === 0) errors.push(`${size}: value is empty`);
  else check("value", projected.value, budget.value);
  if (projected.subtitle !== undefined && budget.subtitle !== null) {
    check("subtitle", projected.subtitle, budget.subtitle);
  }
  if (projected.items !== undefined && budget.items !== null) {
    const itemBudget = budget.items;
    projected.items.forEach((item, index) => {
      check(`items[${index}].label`, item.label, itemBudget.label);
      if (item.value !== undefined) check(`items[${index}].value`, item.value, itemBudget.value);
    });
  }
  return errors.length === 0 ? { ok: true, output: projected } : { ok: false, errors };
}

export function fitAllSizes(output: WidgetOutput): Record<Size, FitResult> {
  return Object.fromEntries(SIZES.map((size) => [size, fitToSize(output, size)])) as Record<Size, FitResult>;
}

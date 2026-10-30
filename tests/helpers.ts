import { expect, type Locator, type Page } from '@playwright/test';

/** Exercise the real menu for both the current Radix and legacy native select. */
export async function selectValue(page: Page, target: string | Locator, value: string): Promise<void> {
  const control = typeof target === 'string' ? page.getByTestId(target) : target;
  if (await control.evaluate(element => element.tagName === 'SELECT')) {
    await control.selectOption(value);
    return;
  }
  await control.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  const options = page.getByRole('option');
  const index = await options.evaluateAll((elements, chosen) => elements.findIndex(element => element.getAttribute('data-value') === chosen), value);
  expect(index, `select offers value ${value}`).toBeGreaterThanOrEqual(0);
  await options.nth(index).click();
  // The selected value may already match. Wait for menu dismissal before a
  // caller sends Escape to its parent dialog or clicks outside the portal.
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(control).toHaveAttribute('data-value', value);
}

import { expect, type ElementHandle, type Locator } from '@playwright/test';

type Contrast = { control: string; ratio: number; minimum: number; foreground: string; background: number[] };
type Result = { state: 'default' | 'hover' | 'focus'; checks: Contrast[] };

async function measure(control: ElementHandle<SVGElement | HTMLElement>): Promise<Contrast[]> {
  return control.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    type Color = [number, number, number, number];
    const parse = (css: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: Color, bottom: Color): Color => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      return [0, 1, 2].map(index => (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha).concat(alpha) as Color;
    };
    const background = (target: Element): Color => {
      const parents: Element[] = [];
      for (let current: Element | null = target; current; current = current.parentElement) parents.unshift(current);
      return parents.reduce((color, parent) => over(parse(getComputedStyle(parent).backgroundColor), color), [255, 255, 255, 1] as Color);
    };
    const luminance = (color: Color) => color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const result: Contrast[] = [];
    const inspect = (target: Element, pseudo?: '::placeholder') => {
      const style = getComputedStyle(target, pseudo);
      const bounds = target.getBoundingClientRect();
      if (style.visibility !== 'visible' || bounds.width <= 1 || bounds.height <= 1) return;
      const bg = background(target);
      const fg = over(parse(style.color), bg);
      const one = luminance(fg), two = luminance(bg);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      result.push({
        control: `${element.tagName.toLowerCase()}.${[...element.classList].filter(name => name.startsWith('cl-') && !name.startsWith('cl-internal')).join('.')}${pseudo ?? ''}`,
        ratio: (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05),
        minimum: large ? 3 : 4.5,
        foreground: style.color,
        background: bg.slice(0, 3).map(value => Math.round(value)),
      });
    };
    if ((element instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'range', 'color'].includes(element.type)) || element instanceof HTMLTextAreaElement) {
      inspect(element);
      if (!element.value && element.placeholder) inspect(element, '::placeholder');
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() && node.parentElement) inspect(node.parentElement);
    }
    return result;
  });
}

/** Check actual SDK-rendered controls and states, including portal content. */
export async function assertClerkControlContrast(root: Locator): Promise<Result[]> {
  // Clerk can remove an autofill field while keyboard focus changes. Snapshot
  // DOM references rather than indexed locators that shift to other controls.
  const controls = await root.locator('button, a[href], input:not([type=hidden]), textarea, select, .cl-badge').elementHandles() as ElementHandle<SVGElement | HTMLElement>[];
  const results: Result[] = [];
  for (const control of controls) {
    const exposed = await control.evaluate(element => {
      if (!element.isConnected || element.closest('[aria-hidden="true"], [inert]')) return false;
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      // Clerk intentionally mounts an unfocusable honeypot password field.
      // A page's generic input CSS can give it bounds despite its hidden role.
      if (element instanceof HTMLInputElement && element.tabIndex < 0) return false;
      return true;
    });
    if (!exposed || !await control.isEnabled() || await control.getAttribute('aria-disabled') === 'true') continue;
    results.push({ state: 'default', checks: await measure(control) });
    if (!await control.evaluate(element => element.matches('button, a[href], input, textarea, select'))) continue;
    await control.hover({ timeout: 5000 });
    results.push({ state: 'hover', checks: await measure(control) });
    // Enter keyboard modality before programmatically locating the same
    // control, so :focus-visible styling is part of the actual measurement.
    await root.page().keyboard.press('Tab');
    await control.focus();
    expect(await control.evaluate(element => element.matches(':focus-visible')), 'the focus check uses keyboard-visible focus').toBe(true);
    results.push({ state: 'focus', checks: await measure(control) });
  }
  const checks = results.flatMap(result => result.checks.map(check => ({ ...check, state: result.state })));
  expect(checks.length, 'real Clerk UI renders measurable text controls').toBeGreaterThan(0);
  const failures = checks.filter(check => check.ratio + 0.01 < check.minimum).map(check => ({
    ...check, ratio: Number(check.ratio.toFixed(2)),
  }));
  expect(failures, 'Clerk controls meet WCAG text contrast in default, hover and keyboard focus states').toEqual([]);
  return results;
}

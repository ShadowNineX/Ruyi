import { JSDOM } from 'jsdom';

const PROFILE_BACKGROUND_SELECTOR = '.no_header.profile_page.has_profile_background';
const BACKGROUND_IMAGE_PROPERTY = 'background-image';

function stripCssUrlQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' || first === '\'') && first === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function getBackgroundImageValue(style: string): string | null {
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) { continue; }

    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property === BACKGROUND_IMAGE_PROPERTY) {
      return declaration.slice(separator + 1).trim();
    }
  }

  return null;
}

function extractCssUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('url(')) { return null; }

  const closing = trimmed.lastIndexOf(')');
  if (closing <= 'url('.length) { return null; }

  const url = stripCssUrlQuotes(trimmed.slice('url('.length, closing));
  return url || null;
}

export function extractSteamProfileBackgroundUrl(html: string): string | null {
  const dom = new JSDOM(html);
  const element = dom.window.document.querySelector(PROFILE_BACKGROUND_SELECTOR);
  const style = element?.getAttribute('style');
  if (!style) { return null; }

  const backgroundImage = getBackgroundImageValue(style);
  return backgroundImage ? extractCssUrl(backgroundImage) : null;
}

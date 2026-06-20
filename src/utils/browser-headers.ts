export const BROWSER_USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const BROWSER_HEADERS = {
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,'
    + 'image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Priority': 'u=0, i',
  'Sec-CH-UA': `"Google Chrome";v="149", "Chromium";v="149", "Not_A Brand";v="99"`,
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': `"Windows"`,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': BROWSER_USER_AGENT,
} as const satisfies HeadersInit;

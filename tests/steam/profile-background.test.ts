import { describe, expect, test } from 'bun:test';
import { extractSteamProfileBackgroundUrl } from '../../src/steam/profile-background';

describe('Steam profile background parsing', () => {
  test('extracts profile background from current Steam profile page wrapper markup', () => {
    const html = `
      <body class="flat_page profile_page has_profile_background GameProfileTheme responsive_page">
        <div class="no_header profile_page has_profile_background"
          style="background-image: url( 'https://shared.fastly.steamstatic.com/community_assets/images/items/3558940/5abfe9d90346eb9d645917ff0bd807756dc06b5f.jpg' );background-repeat: repeat;">
        </div>
      </body>
    `;

    expect(extractSteamProfileBackgroundUrl(html)).toBe(
      'https://shared.fastly.steamstatic.com/community_assets/images/items/3558940/5abfe9d90346eb9d645917ff0bd807756dc06b5f.jpg',
    );
  });

  test('extracts profile background when style contains other declarations', () => {
    const html = `
      <div class="no_header profile_page has_profile_background"
        style="opacity: 1; background-image: url(&quot;https://cdn.example/space.png&quot;); color: black;">
      </div>
    `;

    expect(extractSteamProfileBackgroundUrl(html)).toBe(
      'https://cdn.example/space.png',
    );
  });

  test('ignores old profile background markup', () => {
    const html = `
      <div class="profile_background_image_content"
        style="background-image: url('https://cdn.example/legacy.jpg');">
      </div>
    `;

    expect(extractSteamProfileBackgroundUrl(html)).toBeNull();
  });

  test('returns null when Steam does not expose a profile background', () => {
    expect(extractSteamProfileBackgroundUrl('<main>No background</main>')).toBeNull();
  });
});

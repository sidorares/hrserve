import type { Page } from "playwright";

export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/svg+xml",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

interface ImageReloadResult {
  success: boolean;
  updatedCount: number;
  targetUrl: string;
  timestamp: number;
}

export async function reloadImage(page: Page, targetUrl: string): Promise<ImageReloadResult> {
  // esbuild-based TS runners (tsx) transpile this file with keepNames, which
  // injects `__name(...)` helper calls into the function page.evaluate
  // serializes into the browser; provide a no-op shim so it can run there.
  await page.evaluate("void (globalThis.__name = globalThis.__name || ((fn) => fn))");
  return await page.evaluate(function triggerUpdate(targetUrl) {
    const timestamp = Date.now();
    let updatedCount = 0;

    // Helper function to normalize URLs for comparison
    const normalizeUrl = (url: string, baseUrl = window.location.href) => {
      try {
        return new URL(url, baseUrl).href;
      } catch (e) {
        return url;
      }
    };

    // Helper function to check if URL matches (handles relative URLs)
    const urlMatches = (url1: string, url2: string) => {
      // Remove cache busters before comparing
      const clean1 = url1.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => (p2 ? p1 : ""));
      const clean2 = url2.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => (p2 ? p1 : ""));
      return normalizeUrl(clean1) === normalizeUrl(clean2);
    };

    // Helper function to add cache buster to URL
    const addCacheBuster = (url: string) => {
      // Remove existing cache buster if present
      const cleanUrl = url.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => {
        return p2 ? p1 : "";
      });
      const hasQuery = cleanUrl.includes("?");
      return `${cleanUrl}${hasQuery ? "&" : "?"}_t=${timestamp}`;
    };

    // 1. Update CSS rules
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules || sheet.rules || []);
        for (const rule of rules) {
          if ((rule as CSSStyleRule).style) {
            const styleRule = rule as CSSStyleRule;
            // Check all properties that might contain URLs.
            // getPropertyValue/setProperty only understand hyphenated CSS names
            // (camelCase like "backgroundImage" is silently ignored).
            const urlProperties = [
              "background-image",
              "list-style-image",
              "content",
              "cursor",
              "border-image-source",
              "mask-image",
              "-webkit-mask-image",
            ] as const;

            for (const prop of urlProperties) {
              const value = styleRule.style.getPropertyValue(prop);
              if (value?.includes("url(")) {
                // Extract and check URLs
                const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
                let match = urlRegex.exec(value);
                let newValue = value;
                let changed = false;

                while (match !== null) {
                  const extractedUrl = match[1];
                  if (urlMatches(extractedUrl, targetUrl)) {
                    const newUrl = addCacheBuster(extractedUrl);
                    newValue = newValue.replace(match[0], `url("${newUrl}")`);
                    changed = true;
                  }
                  match = urlRegex.exec(value);
                }

                if (changed) {
                  styleRule.style.setProperty(prop, newValue);
                  updatedCount++;
                }
              }
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheets will throw
        console.log("Cannot access stylesheet:", sheet.href || "inline");
      }
    }

    // 2. Update inline styles
    const elementsWithStyle = document.querySelectorAll("[style]") as NodeListOf<HTMLElement>;
    for (const element of elementsWithStyle) {
      const style = element.style;
      const urlProperties = [
        "background-image",
        "list-style-image",
        "content",
        "cursor",
        "border-image-source",
        "mask-image",
        "-webkit-mask-image",
      ] as const;

      for (const prop of urlProperties) {
        const value = style.getPropertyValue(prop);
        if (value?.includes("url(")) {
          const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
          let match = urlRegex.exec(value);
          let newValue = value;
          let changed = false;

          while (match !== null) {
            const extractedUrl = match[1];
            if (urlMatches(extractedUrl, targetUrl)) {
              const newUrl = addCacheBuster(extractedUrl);
              newValue = newValue.replace(match[0], `url("${newUrl}")`);
              changed = true;
            }
            match = urlRegex.exec(value);
          }

          if (changed) {
            style.setProperty(prop, newValue);
            updatedCount++;
          }
        }
      }
    }

    // 3. Update img elements
    const imgElements = document.querySelectorAll("img");
    for (const img of imgElements) {
      if (img.src && urlMatches(img.src, targetUrl)) {
        img.src = addCacheBuster(img.src);
        updatedCount++;
      }

      // Check srcset
      if (img.srcset) {
        const srcsetParts = img.srcset.split(",").map((s) => s.trim());
        const newSrcset = srcsetParts
          .map((part) => {
            const [url, descriptor] = part.split(/\s+/);
            if (urlMatches(url, targetUrl)) {
              return addCacheBuster(url) + (descriptor ? ` ${descriptor}` : "");
            }
            return part;
          })
          .join(", ");

        if (newSrcset !== img.srcset) {
          img.srcset = newSrcset;
          updatedCount++;
        }
      }
    }

    // 4. Update source elements (in picture elements)
    const sourceElements = document.querySelectorAll("source") as NodeListOf<HTMLSourceElement>;
    for (const source of sourceElements) {
      if (source.srcset) {
        const srcsetParts = source.srcset.split(",").map((s) => s.trim());
        const newSrcset = srcsetParts
          .map((part) => {
            const [url, descriptor] = part.split(/\s+/);
            if (urlMatches(url, targetUrl)) {
              return addCacheBuster(url) + (descriptor ? ` ${descriptor}` : "");
            }
            return part;
          })
          .join(", ");

        if (newSrcset !== source.srcset) {
          source.srcset = newSrcset;
          updatedCount++;
        }
      }
    }

    // 5. Update object/embed elements
    const objectElements = document.querySelectorAll("object") as NodeListOf<HTMLObjectElement>;
    for (const obj of objectElements) {
      if (obj.data && urlMatches(obj.data, targetUrl)) {
        obj.data = addCacheBuster(obj.data);
        updatedCount++;
      }
    }

    const embedElements = document.querySelectorAll("embed") as NodeListOf<HTMLEmbedElement>;
    for (const embed of embedElements) {
      if (embed.src && urlMatches(embed.src, targetUrl)) {
        embed.src = addCacheBuster(embed.src);
        updatedCount++;
      }
    }

    // 6. Update SVG image elements
    const svgImages = document.querySelectorAll("image");
    for (const svgImg of svgImages) {
      const href = svgImg.getAttribute("href") || svgImg.getAttribute("xlink:href");
      if (href && urlMatches(href, targetUrl)) {
        const newHref = addCacheBuster(href);
        svgImg.setAttribute("href", newHref);
        if (svgImg.hasAttribute("xlink:href")) {
          svgImg.setAttribute("xlink:href", newHref);
        }
        updatedCount++;
      }
    }

    // 7. Update link elements (favicons, etc.)
    const linkElements = document.querySelectorAll(
      'link[rel*="icon"]'
    ) as NodeListOf<HTMLLinkElement>;
    for (const link of linkElements) {
      if (link.href && urlMatches(link.href, targetUrl)) {
        link.href = addCacheBuster(link.href);
        updatedCount++;
      }
    }

    // 8. Update input elements with type="image"
    const inputImages = document.querySelectorAll(
      'input[type="image"]'
    ) as NodeListOf<HTMLInputElement>;
    for (const input of inputImages) {
      if (input.src && urlMatches(input.src, targetUrl)) {
        input.src = addCacheBuster(input.src);
        updatedCount++;
      }
    }

    return {
      success: true,
      updatedCount,
      targetUrl,
      timestamp,
    };
  }, targetUrl);
}

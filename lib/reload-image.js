export async function reloadImage(page, targetUrl) {
  return await page.evaluate((targetUrl) => {
    const timestamp = Date.now();
    let updatedCount = 0;
    
    // Helper function to normalize URLs for comparison
    const normalizeUrl = (url, baseUrl = window.location.href) => {
      try {
        return new URL(url, baseUrl).href;
      } catch (e) {
        return url;
      }
    };
    
    // Helper function to check if URL matches (handles relative URLs)
    const urlMatches = (url1, url2) => {
      // Remove cache busters before comparing
      const clean1 = url1.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => p2 ? p1 : '');
      const clean2 = url2.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => p2 ? p1 : '');
      return normalizeUrl(clean1) === normalizeUrl(clean2);
    };
    
    // Helper function to add cache buster to URL
    const addCacheBuster = (url) => {
      // Remove existing cache buster if present
      const cleanUrl = url.replace(/([?&])_t=\d+(&|$)/, (match, p1, p2) => {
        return p2 ? p1 : '';
      });
      const hasQuery = cleanUrl.includes('?');
      return `${cleanUrl}${hasQuery ? '&' : '?'}_t=${timestamp}`;
    };
    
    // 1. Update CSS rules
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules || sheet.rules || []);
        for (const rule of rules) {
          if (rule.style) {
            // Check all properties that might contain URLs
            const urlProperties = [
              'backgroundImage',
              'listStyleImage',
              'content',
              'cursor',
              'borderImageSource',
              'maskImage',
              'webkitMaskImage'
            ];
            
            for (const prop of urlProperties) {
              const value = rule.style[prop];
              if (value?.includes('url(')) {
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
                  rule.style[prop] = newValue;
                  updatedCount++;
                }
              }
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheets will throw
        console.log('Cannot access stylesheet:', sheet.href || 'inline');
      }
    }
    
    // 2. Update inline styles
    const elementsWithStyle = document.querySelectorAll('[style]');
    for (const element of elementsWithStyle) {
      const style = element.style;
      const urlProperties = [
        'backgroundImage',
        'listStyleImage',
        'content',
        'cursor',
        'borderImageSource',
        'maskImage',
        'webkitMaskImage'
      ];
      
      for (const prop of urlProperties) {
        const value = style[prop];
        if (value?.includes('url(')) {
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
            style[prop] = newValue;
            updatedCount++;
          }
        }
      }
    }
    
    // 3. Update img elements
    const imgElements = document.querySelectorAll('img');
    for (const img of imgElements) {
      if (img.src && urlMatches(img.src, targetUrl)) {
        img.src = addCacheBuster(img.src);
        updatedCount++;
      }
      
      // Check srcset
      if (img.srcset) {
        const srcsetParts = img.srcset.split(',').map(s => s.trim());
        const newSrcset = srcsetParts.map(part => {
          const [url, descriptor] = part.split(/\s+/);
          if (urlMatches(url, targetUrl)) {
            return addCacheBuster(url) + (descriptor ? ` ${descriptor}` : '');
          }
          return part;
        }).join(', ');
        
        if (newSrcset !== img.srcset) {
          img.srcset = newSrcset;
          updatedCount++;
        }
      }
    }
    
    // 4. Update source elements (in picture elements)
    const sourceElements = document.querySelectorAll('source');
    for (const source of sourceElements) {
      if (source.srcset) {
        const srcsetParts = source.srcset.split(',').map(s => s.trim());
        const newSrcset = srcsetParts.map(part => {
          const [url, descriptor] = part.split(/\s+/);
          if (urlMatches(url, targetUrl)) {
            return addCacheBuster(url) + (descriptor ? ` ${descriptor}` : '');
          }
          return part;
        }).join(', ');
        
        if (newSrcset !== source.srcset) {
          source.srcset = newSrcset;
          updatedCount++;
        }
      }
    }
    
    // 5. Update object/embed elements
    const objectElements = document.querySelectorAll('object, embed');
    for (const obj of objectElements) {
      if (obj.data && urlMatches(obj.data, targetUrl)) {
        obj.data = addCacheBuster(obj.data);
        updatedCount++;
      }
    }
    
    // 6. Update SVG image elements
    const svgImages = document.querySelectorAll('image');
    for (const svgImg of svgImages) {
      const href = svgImg.getAttribute('href') || svgImg.getAttribute('xlink:href');
      if (href && urlMatches(href, targetUrl)) {
        const newHref = addCacheBuster(href);
        svgImg.setAttribute('href', newHref);
        if (svgImg.hasAttribute('xlink:href')) {
          svgImg.setAttribute('xlink:href', newHref);
        }
        updatedCount++;
      }
    }
    
    // 7. Update link elements (favicons, etc.)
    const linkElements = document.querySelectorAll('link[rel*="icon"]');
    for (const link of linkElements) {
      if (link.href && urlMatches(link.href, targetUrl)) {
        link.href = addCacheBuster(link.href);
        updatedCount++;
      }
    }
    
    // 8. Update input elements with type="image"
    const inputImages = document.querySelectorAll('input[type="image"]');
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
      timestamp
    };
  }, targetUrl);
} 
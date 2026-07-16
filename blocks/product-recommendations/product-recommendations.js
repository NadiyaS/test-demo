// Dropin Tools
import { events } from '@dropins/tools/event-bus.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

// Dropin Components
import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';

// Cart Dropin
import * as cartApi from '@dropins/storefront-cart/api.js';

// Recommendations Dropin
import ProductList from '@dropins/storefront-recommendations/containers/ProductList.js';
import { render as provider } from '@dropins/storefront-recommendations/render.js';
import { publishRecsItemAddToCartClick } from '@dropins/storefront-recommendations/api.js';

// Wishlist Dropin
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';

// Block-level
import { readBlockConfig } from '../../scripts/aem.js';
import { fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';

// Initializers
import '../../scripts/initializers/recommendations.js';
import '../../scripts/initializers/wishlist.js';

const isMobile = window.matchMedia('only screen and (max-width: 900px)').matches;

// Only show recommended products whose `visibility` contains this token.
// The backend returns the ProductView `visibility` string on each item; the
// check is a case-insensitive substring match, so values like 'Search' and
// 'Catalog, Search' both pass while 'Catalog' alone is hidden.
const REQUIRED_VISIBILITY = 'Search';

/**
 * Derives a stable product key from a product URL.
 * Product links are `/products/{urlKey}/{sku}`, so the last path segment
 * (the sku) uniquely identifies a rendered card.
 * @param {string} link - The product link (absolute or relative)
 * @returns {string|null} - The last path segment, or null if not parseable
 */
function getProductKey(link) {
  if (!link) return null;
  try {
    const { pathname } = new URL(link, window.location.origin);
    return pathname.replace(/\/+$/, '').split('/').pop() || null;
  } catch (e) {
    return null;
  }
}

function normalizeVisibility(value) {
  return (value || '').trim().toLowerCase();
}

/**
 * Validates and returns a product view history entry if valid
 * @param {Object} entry - The history entry to validate
 * @returns {Object|null} - Validated history entry or null if invalid
 */
function getValidHistoryEntry(entry) {
  // Basic validation to ensure the entry has necessary properties
  if (entry && typeof entry === 'object' && entry.sku && entry.date) {
    return {
      sku: entry.sku,
      date: entry.date,
    };
  }
  return null;
}

/**
 * Gets product view history from localStorage
 * @param {string} storeViewCode - The store view code
 * @returns {Array} - Array of view history items
 */
function getProductViewHistory(storeViewCode) {
  try {
    const viewHistory = window.localStorage.getItem(`${storeViewCode}:productViewHistory`) || '[]';
    const parsedHistory = JSON.parse(viewHistory);
    if (!Array.isArray(parsedHistory)) {
      throw new Error('Product view history is not an array');
    }
    const validHistory = parsedHistory.map(getValidHistoryEntry).filter((entry) => entry !== null);
    if (validHistory.length === 0) {
      // If no valid entries, clear the history to prevent future parsing issues
      window.localStorage.removeItem(`${storeViewCode}:productViewHistory`);
    }
    return validHistory;
  } catch (e) {
    window.localStorage.removeItem(`${storeViewCode}:productViewHistory`);
    console.error('Error parsing product view history', e);
    return [];
  }
}

/**
 * Gets purchase history from localStorage
 * @param {string} storeViewCode - The store view code
 * @returns {Array} - Array of purchase history items
 */
function getPurchaseHistory(storeViewCode) {
  try {
    const purchaseHistory = window.localStorage.getItem(`${storeViewCode}:purchaseHistory`) || '[]';
    return JSON.parse(purchaseHistory);
  } catch (e) {
    window.localStorage.removeItem(`${storeViewCode}:purchaseHistory`);
    console.error('Error parsing purchase history', e);
    return [];
  }
}

export default async function decorate(block) {
  const labels = await fetchPlaceholders();

  // Hide configuration rows if they exist
  const children = [...block.children];
  children.forEach((child) => {
    child.style.display = 'none';
  });

  // Configuration
  const { currentsku, recid } = readBlockConfig(block);

  // Layout
  const fragment = document.createRange().createContextualFragment(`
    <div class="recommendations__wrapper">
      <div class="recommendations__list"></div>
    </div>
  `);

  const $list = fragment.querySelector('.recommendations__list');
  const $wrapper = fragment.querySelector('.recommendations__wrapper');

  block.appendChild(fragment);

  const createProductLink = (item) => getProductLink(item.urlKey, item.sku);

  let visibility = !isMobile;
  let isLoading = false;
  let loadTimeout = null;
  // Latest recommendation units emitted on the `recommendations/data` event.
  // The ProductList container fetches and renders on its own, so we cannot
  // filter the data before render — instead we hide rendered cards whose
  // product visibility is not allowed, using this data to look visibility up.
  let recommendationsData = null;

  /**
   * Hides rendered recommendation cards whose product visibility does not
   * contain REQUIRED_VISIBILITY. Cards render as `.dropin-product-item-card`;
   * each is matched back to its item via the sku in its product link.
   * @param {HTMLElement} container - The recommendations wrapper element
   */
  function applyVisibilityFilter(container) {
    if (!Array.isArray(recommendationsData)) return;

    // Map product key (sku from link) -> visibility for all recommended items.
    const visibilityByKey = new Map();
    recommendationsData.forEach((unit) => {
      unit?.items?.forEach((item) => {
        const key = getProductKey(createProductLink(item));
        if (key) visibilityByKey.set(key, item.visibility);
      });
    });
    if (visibilityByKey.size === 0) return;

    let visibleCount = 0;
    container.querySelectorAll('.dropin-product-item-card').forEach((card) => {
      const link = card.querySelector('a[href*="/products/"]');
      const key = getProductKey(link?.getAttribute('href'));
      const cardVisibility = key ? visibilityByKey.get(key) : undefined;

      const hide = cardVisibility !== undefined
        && !normalizeVisibility(cardVisibility).includes(normalizeVisibility(REQUIRED_VISIBILITY));

      card.style.display = hide ? 'none' : '';
      if (!hide) visibleCount += 1;
    });

    // Hide the whole unit if nothing passed the visibility filter,
    // and restore it if a later render brings matching products back.
    $wrapper.style.display = visibleCount === 0 ? 'none' : '';
  }

  // Re-apply the filter whenever the container re-renders (render is async
  // and can happen after the `recommendations/data` event fires).
  const filterObserver = new MutationObserver(() => applyVisibilityFilter($wrapper));
  filterObserver.observe($wrapper, { childList: true, subtree: true });

  async function loadRecommendation(
    context,
    isVisible,
    container,
    forceReload = false,
  ) {
    // Only load once the recommendation becomes visible
    if (!isVisible) {
      return;
    }

    // Prevent multiple simultaneous loads
    if (isLoading) {
      return;
    }

    // Only proceed if container is empty or force reload is requested
    if (container.children.length > 0 && !forceReload) {
      return;
    }

    isLoading = true;

    // Clear container if reloading
    if (forceReload) {
      container.innerHTML = '';
    }

    const storeViewCode = getConfigValue('headers.cs.Magento-Store-View-Code');

    // Get product view history
    context.userViewHistory = getProductViewHistory(storeViewCode);

    // Get purchase history
    context.userPurchaseHistory = getPurchaseHistory(storeViewCode);

    // Get data from the event bus to set publish events
    events.on(
      'recommendations/data',
      (data) => {
        recommendationsData = data;
        // Filter the freshly rendered cards by product visibility.
        applyVisibilityFilter($wrapper);
      },
      { eager: true },
    );

    try {
      await Promise.all([
        provider.render(ProductList, {
          routeProduct: createProductLink,
          recId: recid,
          currentSku: currentsku || context.currentSku,
          userViewHistory: context.userViewHistory,
          userPurchaseHistory: context.userPurchaseHistory,
          slots: {
            Footer: (ctx) => {
              const wrapper = document.createElement('div');
              wrapper.className = 'footer__wrapper';

              const addToCart = document.createElement('div');
              addToCart.className = 'footer__button--add-to-cart';
              wrapper.appendChild(addToCart);

              if (ctx.item.itemType === 'SimpleProductView') {
                // Add to Cart Button
                UI.render(Button, {
                  children: labels.Global?.AddProductToCart,
                  icon: Icon({ source: 'Cart' }),
                  onClick: (event) => {
                    cartApi.addProductsToCart([
                      { sku: ctx.item.sku, quantity: 1 },
                    ]);
                    // Prevent the click event from bubbling up to the parent span
                    // to avoid triggering the recs-item-click event
                    event.stopPropagation();
                    // Publish ACDL event for add to cart click
                    const recommendationUnit = recommendationsData?.find(
                      (unit) => unit.items?.some(
                        (unitItem) => unitItem.sku === ctx.item.sku,
                      ),
                    );
                    publishRecsItemAddToCartClick({
                      recommendationUnit,
                      pagePlacement: 'product-list',
                      yOffsetTop: addToCart.getBoundingClientRect().top ?? 0,
                      yOffsetBottom:
                        addToCart.getBoundingClientRect().bottom ?? 0,
                      productId: ctx.index,
                    });
                  },
                  variant: 'primary',
                })(addToCart);
              } else {
                // Select Options Button
                UI.render(Button, {
                  children:
                    labels.Global?.SelectProductOptions,
                  href: createProductLink(ctx.item),
                  variant: 'tertiary',
                })(addToCart);
              }

              // Wishlist Button
              const $wishlistToggle = document.createElement('div');
              $wishlistToggle.classList.add('footer__button--wishlist-toggle');

              // Render Icon
              wishlistRender.render(WishlistToggle, {
                product: ctx.item,
              })($wishlistToggle);

              // Append to Cart Item
              wrapper.appendChild($wishlistToggle);

              ctx.replaceWith(wrapper);
            },

            Thumbnail: (ctx) => {
              const { item, defaultImageProps } = ctx;
              const wrapper = document.createElement('a');
              wrapper.href = createProductLink(item);

              tryRenderAemAssetsImage(ctx, {
                alias: item.sku,
                imageProps: defaultImageProps,
                wrapper,

                params: {
                  width: defaultImageProps.width,
                  height: defaultImageProps.height,
                },
              });
            },
          },
        })($wrapper),
      ]);
    } finally {
      isLoading = false;
    }
  }

  const context = {};
  // Debounced loader to prevent excessive API calls
  function debouncedLoadRecommendation(forceReload = false) {
    if (loadTimeout) {
      clearTimeout(loadTimeout);
    }

    loadTimeout = setTimeout(() => {
      loadRecommendation(context, visibility, $list, forceReload);
    }, 300); // 300ms debounce
  }

  // Track previous context values to detect significant changes
  let previousContext = {};

  function shouldReloadRecommendations(newContext) {
    // Check if significant context changes occurred that warrant reloading recommendations
    const significantChanges = ['currentSku', 'pageType', 'category'];

    return significantChanges.some(
      (key) => newContext[key] !== previousContext[key] && newContext[key] !== undefined,
    );
  }

  function updateContext(updates) {
    const hasSignificantChanges = shouldReloadRecommendations({
      ...context,
      ...updates,
    });

    // Update context
    Object.assign(context, updates);

    // Update previous context for next comparison
    previousContext = { ...context };

    // Load or reload recommendations based on whether significant changes occurred
    if (hasSignificantChanges && $list.children.length > 0) {
      // Force reload if recommendations already exist and context changed significantly
      debouncedLoadRecommendation(true);
    } else {
      // Initial load or minor context changes
      debouncedLoadRecommendation(false);
    }
  }

  function handleProductChanges({ productContext }) {
    updateContext({ currentSku: productContext?.sku });
  }

  function handleCategoryChanges({ categoryContext }) {
    updateContext({ category: categoryContext?.name });
  }

  function handlePageTypeChanges({ pageContext }) {
    updateContext({ pageType: pageContext?.pageType });
  }

  function handleCartChanges({ shoppingCartContext }) {
    const cartSkus = shoppingCartContext?.totalQuantity === 0
      ? []
      : shoppingCartContext?.items?.map(({ product }) => product.sku);
    updateContext({ cartSkus });
  }

  window.adobeDataLayer.push((dl) => {
    dl.addEventListener('adobeDataLayer:change', handlePageTypeChanges, { path: 'pageContext' });
    dl.addEventListener('adobeDataLayer:change', handleProductChanges, { path: 'productContext' });
    dl.addEventListener('adobeDataLayer:change', handleCategoryChanges, { path: 'categoryContext' });
    dl.addEventListener('adobeDataLayer:change', handleCartChanges, { path: 'shoppingCartContext' });
  });

  if (isMobile) {
    const section = block.closest('.section');
    const inViewObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          visibility = true;
          debouncedLoadRecommendation(false);
          inViewObserver.disconnect();
        }
      });
    });
    inViewObserver.observe(section);
  }
}

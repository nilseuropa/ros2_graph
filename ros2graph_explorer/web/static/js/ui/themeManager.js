const STORAGE_THEME_KEY = 'ros2graph_explorer.theme';
const STORAGE_CUSTOM_KEY = 'ros2graph_explorer.theme.custom';

const CUSTOM_COLOR_KEYS = [
  'bg',
  'panel',
  'text',
  'accent',
  'accentSecondary',
  'graphEdge',
  'graphEdgeHover',
  'graphEdgeSelect',
  'graphNodeFill',
  'graphNodeHover',
  'graphNodeSelect',
  'graphTopicFill',
  'graphTopicHover',
  'graphTopicSelect',
  'graphLabelText',
];

const BUILTIN_THEMES = {
  dark: {
    name: 'dark',
    scheme: 'dark',
    colors: {
      bg: '#0d1117',
      panel: '#161b22',
      text: '#e6edf3',
      accent: '#3fb950',
      accentSecondary: '#58a6ff',
      graphEdge: '#3a4b5e',
      graphEdgeHover: '#5cb2ff',
      graphEdgeSelect: '#ffab3d',
      graphNodeFill: '#2b4a65',
      graphNodeHover: '#3f6d90',
      graphNodeSelect: '#4b7da1',
      graphTopicFill: '#14202c',
      graphTopicHover: '#162331',
      graphTopicSelect: '#1f2e41',
      graphLabelText: '#f0f6fc',
    },
  },
  light: {
    name: 'light',
    scheme: 'light',
    colors: {
      bg: '#f6f8fa',
      panel: '#ffffff',
      text: '#1f2328',
      accent: '#2da44e',
      accentSecondary: '#0969da',
      graphEdge: '#667085',
      graphEdgeHover: '#1f6feb',
      graphEdgeSelect: '#bd561d',
      graphNodeFill: '#d6e5ff',
      graphNodeHover: '#c6dbff',
      graphNodeSelect: '#ffe2c2',
      graphTopicFill: '#eef6ff',
      graphTopicHover: '#e0edf9',
      graphTopicSelect: '#ffeddc',
      graphLabelText: '#1f2328',
    },
  },
};

const DEFAULT_CUSTOM_THEME = {
  scheme: 'dark',
  colors: { ...BUILTIN_THEMES.dark.colors },
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const SHADOWS = {
  dark: {
    lg: '0 12px 24px rgba(0, 0, 0, 0.4)',
    xl: '0 16px 48px rgba(0, 0, 0, 0.45)',
    xxl: '0 28px 64px rgba(0, 0, 0, 0.5)',
    dialog: '0 24px 60px rgba(0, 0, 0, 0.45)',
  },
  light: {
    lg: '0 12px 24px rgba(15, 23, 42, 0.18)',
    xl: '0 16px 48px rgba(15, 23, 42, 0.2)',
    xxl: '0 28px 64px rgba(15, 23, 42, 0.22)',
    dialog: '0 24px 60px rgba(15, 23, 42, 0.2)',
  },
};

function cloneThemeConfig(theme) {
  return {
    scheme: theme.scheme,
    colors: { ...theme.colors },
  };
}

function normalizeHex(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }
  let hex = value.trim();
  if (!hex) {
    return fallback;
  }
  if (!hex.startsWith('#')) {
    hex = `#${hex}`;
  }
  if (/^#[0-9a-fA-F]{6}$/u.test(hex)) {
    return hex.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/u.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) {
    return null;
  }
  const value = normalized.slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToString(rgb) {
  if (!rgb) {
    return '';
  }
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
}

function setColorProperty(style, name, hex) {
  const normalized = normalizeHex(hex);
  if (normalized) {
    style.setProperty(name, normalized);
  }
}

function setRgbProperty(style, name, hex) {
  const rgb = hexToRgb(hex);
  if (rgb) {
    style.setProperty(name, rgbToString(rgb));
  }
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(storage, key) {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // ignore persistence errors (private browsing, etc.)
  }
}

export class ThemeManager {
  constructor({ storage } = {}) {
    this.storage = storage ?? getStorage();
    this.themeName = 'dark';
    this.customTheme = cloneThemeConfig(DEFAULT_CUSTOM_THEME);
    this.listeners = new Set();
    this.activeTheme = {
      name: 'dark',
      scheme: BUILTIN_THEMES.dark.scheme,
      colors: { ...BUILTIN_THEMES.dark.colors },
    };
  }

  init() {
    this.loadFromStorage();
    this.applyTheme(this.themeName, { persist: false, silent: true });
  }

  loadFromStorage() {
    const storedCustom = safeGet(this.storage, STORAGE_CUSTOM_KEY);
    if (storedCustom) {
      try {
        const payload = JSON.parse(storedCustom);
        if (payload && typeof payload === 'object') {
          const next = cloneThemeConfig(DEFAULT_CUSTOM_THEME);
          if (payload.scheme === 'light') {
            next.scheme = 'light';
          }
          if (payload.colors && typeof payload.colors === 'object') {
            for (const key of CUSTOM_COLOR_KEYS) {
              const value = normalizeHex(payload.colors[key], next.colors[key]);
              next.colors[key] = value ?? next.colors[key];
            }
          }
          this.customTheme = next;
        }
      } catch {
        // ignore corrupted custom theme payloads
      }
    }
    const storedTheme = safeGet(this.storage, STORAGE_THEME_KEY);
    if (storedTheme === 'custom') {
      this.themeName = storedCustom ? 'custom' : 'dark';
      return;
    }
    if (storedTheme && hasOwn(BUILTIN_THEMES, storedTheme)) {
      this.themeName = storedTheme;
    }
  }

  applyTheme(name, { persist = true, silent = false } = {}) {
    const target = name === 'custom' ? 'custom' : hasOwn(BUILTIN_THEMES, name) ? name : 'dark';
    this.themeName = target;
    if (persist) {
      safeSet(this.storage, STORAGE_THEME_KEY, target);
    }
    const theme =
      target === 'custom'
        ? {
            name: 'custom',
            scheme: this.customTheme.scheme === 'light' ? 'light' : 'dark',
            colors: { ...this.customTheme.colors },
          }
        : {
            name: target,
            scheme: BUILTIN_THEMES[target].scheme,
            colors: { ...BUILTIN_THEMES[target].colors },
          };
    this.activeTheme = theme;
    this.applyThemeToDom(theme);
    if (!silent) {
      this.notify();
    }
  }

  applyThemeToDom(theme) {
    const body = document.body;
    if (!body) {
      return;
    }
    const style = body.style;
    body.dataset.theme = theme.name;

    setColorProperty(style, '--bg', theme.colors.bg);
    setRgbProperty(style, '--bg-rgb', theme.colors.bg);
    setColorProperty(style, '--panel', theme.colors.panel);
    setRgbProperty(style, '--panel-rgb', theme.colors.panel);
    setColorProperty(style, '--text', theme.colors.text);
    setRgbProperty(style, '--text-rgb', theme.colors.text);
    setColorProperty(style, '--accent', theme.colors.accent);
    setRgbProperty(style, '--accent-rgb', theme.colors.accent);
    setColorProperty(style, '--accent-secondary', theme.colors.accentSecondary);
    setRgbProperty(style, '--accent-secondary-rgb', theme.colors.accentSecondary);
    setColorProperty(style, '--graph-edge', theme.colors.graphEdge);
    setColorProperty(style, '--graph-edge-hover', theme.colors.graphEdgeHover);
    setColorProperty(style, '--graph-edge-select', theme.colors.graphEdgeSelect);
    setColorProperty(style, '--graph-node-fill', theme.colors.graphNodeFill);
    setColorProperty(style, '--graph-node-hover', theme.colors.graphNodeHover);
    setColorProperty(style, '--graph-node-select', theme.colors.graphNodeSelect);
    setColorProperty(style, '--graph-topic-fill', theme.colors.graphTopicFill);
    setColorProperty(style, '--graph-topic-hover', theme.colors.graphTopicHover);
    setColorProperty(style, '--graph-topic-select', theme.colors.graphTopicSelect);
    setColorProperty(style, '--graph-label-text', theme.colors.graphLabelText);

    const scheme = theme.scheme === 'light' ? 'light' : 'dark';
    const set = SHADOWS[scheme] ?? SHADOWS.dark;
    style.setProperty('--shadow-lg', set.lg);
    style.setProperty('--shadow-xl', set.xl);
    style.setProperty('--shadow-xxl', set.xxl);
    style.setProperty('--shadow-dialog', set.dialog);

    if (theme.name === 'custom') {
      style.setProperty('--custom-color-scheme', scheme);
    } else {
      style.removeProperty('--custom-color-scheme');
    }
  }

  setTheme(name) {
    this.applyTheme(name);
  }

  getTheme() {
    return this.themeName;
  }

  getState() {
    return {
      theme: this.themeName,
      custom: cloneThemeConfig(this.customTheme),
      graphPalette: this.getGraphPalette(),
    };
  }

  getGraphPalette() {
    const theme = this.activeTheme ?? {
      name: this.themeName,
      scheme: BUILTIN_THEMES[this.themeName]?.scheme ?? 'dark',
      colors: {
        ...BUILTIN_THEMES[this.themeName]?.colors,
      },
    };
    return {
      edge: theme.colors.graphEdge,
      edgeHover: theme.colors.graphEdgeHover,
      edgeSelect: theme.colors.graphEdgeSelect,
      node: {
        baseFill: theme.colors.graphNodeFill,
        hoverFill: theme.colors.graphNodeHover,
        selectFill: theme.colors.graphNodeSelect,
      },
      topic: {
        baseFill: theme.colors.graphTopicFill,
        hoverFill: theme.colors.graphTopicHover,
        selectFill: theme.colors.graphTopicSelect,
      },
      labelText: theme.colors.graphLabelText,
    };
  }

  setCustomColor(key, value) {
    if (!CUSTOM_COLOR_KEYS.includes(key)) {
      return;
    }
    const normalized = normalizeHex(value, this.customTheme.colors[key]);
    if (!normalized) {
      return;
    }
    this.customTheme.colors[key] = normalized;
    this.persistCustomTheme();
    if (this.themeName === 'custom') {
      this.applyTheme('custom', { persist: false, silent: true });
    }
    this.notify();
  }

  setCustomScheme(scheme) {
    const next = scheme === 'light' ? 'light' : 'dark';
    if (this.customTheme.scheme === next) {
      return;
    }
    this.customTheme.scheme = next;
    this.persistCustomTheme();
    if (this.themeName === 'custom') {
      this.applyTheme('custom', { persist: false, silent: true });
    }
    this.notify();
  }

  resetCustomTheme() {
    this.customTheme = cloneThemeConfig(DEFAULT_CUSTOM_THEME);
    this.persistCustomTheme();
    if (this.themeName === 'custom') {
      this.applyTheme('custom', { persist: false, silent: true });
    }
    this.notify();
  }

  persistCustomTheme() {
    safeSet(this.storage, STORAGE_CUSTOM_KEY, JSON.stringify(this.customTheme));
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify() {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore listener errors to avoid breaking theming flow
      }
    }
  }
}

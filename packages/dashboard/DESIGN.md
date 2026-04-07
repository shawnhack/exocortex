# Design System

Black/cyan terminal aesthetic — retro scanlines, breathing glows, custom CSS variables. No Tailwind.

## Tokens

### Colors

```
Backgrounds:     #030308 (root) → #040410 (sidebar) → #080814 (card) → #0a0a18 (input) → #0c0c1d (surface) → #0e0e1e (hover)
Overlays:        rgba(8,8,26, 0.4/0.5/0.6/0.8/0.92)
Panels:          rgba(22,22,58, 0.3/0.4/0.5)

Cyan (primary):  #22d3ee (main) · #06b6d4 (dark) · #67e8f9 (light) · #a5f3fc (lighter) · #00ffff (pure)
Cyan opacity:    0.04 (faint bg) · 0.06 (subtle bg) · 0.08 (tag bg) · 0.12 (dim) · 0.15 (border/bg) · 0.25 (hover bg) · 0.3 (border) · 0.4 (strong border)

Emerald:         #34d399 (success)
Amber:           #fbbf24 (warning)
Rose:            #f472b6 (pink)
Red:             #f87171 / #ef4444 / #ff6b6b (error variants)
Green:           #4ade80
Sky:             #38bdf8
Purple:          #a78bfa / #8b5cf6

Text:            #e0f0f4 (primary) · #e8e8f4 (alt) · #d0d0e0 (body) · #8899aa (secondary) · #667788 (dim) · #5a5a78 (faint) · #606080 (disabled)
Borders:         #121228 (default) · #16163a (subtle) · #0d0d24 (inner) · #1e1e4a (mid) · #22223a (panel)

Tier colors:     working=#8080a0 · episodic=#fbbf24 · semantic=#a78bfa · procedural=#34d399 · reference=#38bdf8
```

### Typography

```
UI font:         'Outfit', system-ui, -apple-system, sans-serif (--font-ui)
Mono:            'JetBrains Mono', 'Fira Code', monospace (--font-mono)
Base size:       14px
Line-height:     1.6
Headings:        h1=1.6rem/700 · h2=1.15rem/600 · h3=1rem/600
Letter-spacing:  -0.01em (headings) · 0.01em (buttons) · 0.02em (small) · 0.03em (badges)
```

### Spacing & Radius

```
Radius:          6px (sm) · 8px (standard) · 12px (lg/cards) · 20px (pills)
Sidebar:         256px expanded · 64px collapsed
Content:         32px 40px padding, max-width 1000px
Card padding:    20px
Button padding:  10px 20px (standard) · 6px 12px (small)
Badge padding:   3px 10px
Input padding:   10px 14px
```

### Shadows & Glows

```
Shadow heavy:    0 8px 32px rgba(0,0,0,0.5)
Shadow light:    0 1px 3px rgba(0,0,0,0.3)
Glow cyan:       0 0 20px rgba(34,211,238,0.12), 0 0 60px rgba(34,211,238,0.04)
Glow strong:     0 0 24px rgba(34,211,238,0.2), 0 0 60px rgba(34,211,238,0.06)
Focus ring:      0 0 0 3px rgba(34,211,238,0.12)
```

### Transitions

```
All:             0.2s (standard) · 0.25s (focus/border) · 0.4s ease-out (score bars)
```

## Component Patterns

### Cards

- bg: var(--bg-card), border: 1px var(--border), radius: 12px, padding: 20px

### Badges

- 11px, 600 weight, 0.03em spacing, radius 20px (pill), padding 3px 10px
- Variants: cyan (violet-dim bg), emerald, amber, rose — each uses color-dim bg + color text

### Buttons

- **Primary**: cyan gradient bg, black text, cyan border, glow + translateY(-1px) on hover
- **Secondary**: bg-input, border, glow on hover
- **Ghost**: transparent, secondary text, subtle cyan bg on hover
- **Danger**: red-dim bg, red text

### Forms

- bg-input, border, radius 6px, padding 10px 14px
- Focus: cyan border + glow ring (0 0 0 3px violet-dim)

### Filter/Stat Pills

- 6px 14px padding, radius 20px, border, 13px font
- Active: cyan gradient bg, black text, or violet-dim bg + cyan text

### Status

- Score bars: 3px height, cyan gradient fill, glow shadow
- Spinners: 18px, 2px border, cyan top-border, 0.6s rotation
- Empty states: centered, 48px padding, text-dim

### Layout

```
App
├── Sidebar (fixed left, 256px/64px, gradient bg, breathing cyan border-right)
│   ├── Nav items: icon 18px + label, 9px 14px padding
│   └── Active: 2px cyan left border
└── Main (flex 1, scroll, max-w 1000px, 32px 40px padding)
    └── Mobile: sidebar overlay, hamburger menu, 768px breakpoint
```

### Ambient Effects

- Body::before: two radial cyan gradients (20%/80% position, 0.025/0.015 opacity)
- Body::after: 2px repeating scanlines at 0.006 opacity, pointer-events: none
- Scrollbar: 6px, cyan 0.15 thumb → 0.3 hover

## Anti-Patterns

- No Tailwind — pure CSS variables + inline React styles
- No component library — hand-crafted
- No light mode — dark only
- force-graph for entity visualization (not 3d-force-graph)
- Node colors by degree: >=8 cyan, >=4 dark cyan, >=2 darker, else dimmest

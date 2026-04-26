// Round palettes — single-hue gradient (light → dark by round)
// Each palette has 7 entries (rounds 1-7), dark mode variants too.

const PALETTES = {
  forest: {
    label: 'Forest',
    hue: 145,
    light: ['#E8F2EC', '#CFE3D6', '#A8CFB6', '#7CB893', '#549E73', '#357C56', '#1E5A3C'],
    dark:  ['#1B2C23', '#21392C', '#2A4D38', '#356549', '#42805A', '#54A06F', '#74C18A'],
    text: ['#1E5A3C','#1E5A3C','#1E5A3C','#0E3322','#FFFFFF','#FFFFFF','#FFFFFF'],
    textDark: ['#A8D6B8','#BCDFC8','#CFE9D7','#DEF1E2','#ECF7EC','#F4FBF4','#FFFFFF'],
  },
  ember: {
    label: 'Ember',
    hue: 22,
    light: ['#FBEDE3', '#F8DAC4', '#F2BC97', '#EA9A66', '#DC7A3E', '#B85B26', '#8A4017'],
    dark:  ['#2E211A', '#3B271E', '#4D3023', '#653B27', '#82482B', '#A65A33', '#CC7144'],
    text: ['#8A4017','#8A4017','#5C2A0E','#3B1A07','#FFFFFF','#FFFFFF','#FFFFFF'],
    textDark: ['#E5C7B2','#EDD3BB','#F4DEC4','#F9E8CD','#FCEFD3','#FEF5DC','#FFFFFF'],
  },
  ocean: {
    label: 'Ocean',
    hue: 220,
    light: ['#E7EEF7', '#CCDBEB', '#A3BED8', '#759CBE', '#4F7BA3', '#345C82', '#1E4063'],
    dark:  ['#1B2632', '#21303F', '#293E51', '#345067', '#436685', '#557EA4', '#6E97BF'],
    text: ['#1E4063','#1E4063','#1E4063','#0E2440','#FFFFFF','#FFFFFF','#FFFFFF'],
    textDark: ['#A8C0DA','#BBCDE2','#CDD9E9','#DCE4ED','#E9EDF3','#F2F5F9','#FFFFFF'],
  },
  violet: {
    label: 'Violet',
    hue: 280,
    light: ['#EFEBF6', '#DBD2EB', '#BFB0DB', '#9E89C6', '#7E64AC', '#5E468B', '#412F66'],
    dark:  ['#241F2E', '#2D2738', '#3B3148', '#4D405E', '#635175', '#7E6790', '#9C82AC'],
    text: ['#412F66','#412F66','#412F66','#241941','#FFFFFF','#FFFFFF','#FFFFFF'],
    textDark: ['#C7BBDA','#D2C8E1','#DCD4E7','#E5DFEC','#ECE7F1','#F3EFF6','#FFFFFF'],
  },
  graphite: {
    label: 'Graphite',
    hue: 0,
    light: ['#F1F1F1', '#DDDDDD', '#C3C3C3', '#A4A4A4', '#7E7E7E', '#5A5A5A', '#3A3A3A'],
    dark:  ['#1F1F1F', '#2A2A2A', '#363636', '#444444', '#575757', '#717171', '#8E8E8E'],
    text: ['#3A3A3A','#3A3A3A','#3A3A3A','#1A1A1A','#FFFFFF','#FFFFFF','#FFFFFF'],
    textDark: ['#BABABA','#C8C8C8','#D3D3D3','#DEDEDE','#E7E7E7','#EFEFEF','#FFFFFF'],
  },
};

window.PALETTES = PALETTES;

// Helper: pick swatch for a round (1-7)
window.roundSwatch = (palette, round, dark) => {
  const p = PALETTES[palette] || PALETTES.forest;
  const idx = Math.max(0, Math.min(6, round - 1));
  return {
    bg: dark ? p.dark[idx] : p.light[idx],
    fg: dark ? p.textDark[idx] : p.text[idx],
  };
};

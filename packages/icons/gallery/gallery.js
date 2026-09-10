const body = document.body;
const cards = [...document.querySelectorAll('.icon-card')];
const search = document.querySelector('#search');
const category = document.querySelector('#category');
const inspector = document.querySelector('#inspector');
const code = document.querySelector('#code');
const copyStatus = document.querySelector('#copy-status');
let currentSvg = '';
let currentReact = '';

document.querySelectorAll('[name="appearance"]').forEach((input) => {
  input.addEventListener('change', () => {
    body.dataset.appearance = input.value;
  });
});

document.querySelector('#colors').addEventListener('change', (event) => {
  body.dataset.colors = String(event.target.checked);
});

document.querySelector('#shadows').addEventListener('change', (event) => {
  document.querySelectorAll('.droid-icon-badge').forEach((badge) => {
    badge.dataset.droidIconShadow = String(event.target.checked);
  });
});

document.querySelector('#size').addEventListener('change', (event) => {
  body.style.setProperty('--preview-size', `${event.target.value}px`);
});

document.querySelector('#theme').addEventListener('change', (event) => {
  document.documentElement.dataset.theme = event.target.value;
});

function filterIcons() {
  const query = search.value.replace(/[\s-]+/g, '').toLowerCase();
  let count = 0;
  for (const card of cards) {
    card.hidden =
      !card.dataset.search.includes(query) ||
      Boolean(category.value && card.dataset.category !== category.value);
    if (!card.hidden) count++;
  }
  document.querySelector('#count').textContent = String(count);
  document.querySelector('#empty').hidden = count > 0;
}

search.addEventListener('input', filterIcons);
category.addEventListener('change', filterIcons);

document.querySelectorAll('.inspectable').forEach((button) => {
  button.addEventListener('click', () => {
    const drawing =
      button.querySelector(`[data-variant="${body.dataset.appearance}"]`) ||
      button.querySelector('.drawing');
    const name = drawing.dataset.export;
    const size = document.querySelector('#size').value;
    const svg = drawing.querySelector('svg').cloneNode(true);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Downloads are static SVGs; animation stays an explicit CSS opt-in.
    svg.removeAttribute('class');
    currentSvg = svg.outerHTML;
    const spinner = name === 'Spinner';
    const styles = spinner ? '\nimport "@droidex/icons/styles.css";' : '';
    const animation = spinner ? ' className="droid-icon-spin"' : '';
    currentReact = `import { ${name} } from "@droidex/icons";${styles}\n\n<${name} size={${size}}${animation} />`;
    code.value = currentReact;
    copyStatus.textContent = '';
    document.querySelector('#inspector-title').textContent = name;
    document.querySelector('#inspector-preview').replaceChildren(svg);
    const download = document.querySelector('#download');
    download.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(currentSvg)}`;
    download.download = `${drawing.dataset.slug}.svg`;
    inspector.showModal();
  });
});

async function copy(value) {
  code.value = value;
  try {
    await navigator.clipboard.writeText(value);
    copyStatus.textContent = 'Copied to clipboard.';
  } catch {
    code.focus();
    code.select();
    copyStatus.textContent = 'Clipboard unavailable. The code is selected; copy it manually.';
  }
}

document.querySelector('#copy-react').addEventListener('click', () => void copy(currentReact));
document.querySelector('#copy-svg').addEventListener('click', () => void copy(currentSvg));
document.querySelector('#close').addEventListener('click', () => inspector.close());

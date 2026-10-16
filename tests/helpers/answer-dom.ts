// Small DOM fixture for exercising the real preload selection path in Node.
export class AnswerElement {
  children: AnswerElement[] = [];
  parentElement: AnswerElement | null = null;
  checked = false;
  constructor(public tagName: string, public attrs: Record<string, string> = {}, public text = '') {}
  get id() { return this.attrs.id || ''; }
  get name() { return this.attrs.name || ''; }
  get value() { return this.attrs.value || ''; }
  set value(value: string) { this.attrs.value = value; }
  get className() { return this.attrs.class || ''; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    return {
      [Symbol.iterator]: () => tokens()[Symbol.iterator](),
      contains: (name: string) => tokens().includes(name),
      toggle: (name: string, force: boolean) => {
        this.attrs.class = [...new Set([...tokens().filter(token => token !== name), ...(force ? [name] : [])])].join(' ');
      }
    };
  }
  append(...nodes: AnswerElement[]) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); return this; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  contains(node: AnswerElement): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selectors: string): boolean {
    return selectors.split(',').some(selector => {
      let valid = true;
      let rest = selector.trim().replace(/:not\(([^)]+)\)/g, (_, part) => { valid &&= !this.matches(part); return ''; });
      rest = rest.replace(/\[([^\s=*^\]]+)\s*(\^?=)?\s*(?:"([^"]*)"|'([^']*)')?\s*\]/g, (_, name, op, a, b) => {
        const actual = this.getAttribute(name), expected = a ?? b ?? '';
        valid &&= op === '^=' ? actual?.startsWith(expected) === true : op === '=' ? actual === expected : actual !== null;
        return '';
      });
      rest = rest.replace(/#([\w-]+)/g, (_, id) => { valid &&= this.id === id; return ''; });
      rest = rest.replace(/\.([\w-]+)/g, (_, name) => { valid &&= this.classList.contains(name); return ''; });
      return valid && (!rest || rest === '*' || rest.toUpperCase() === this.tagName.toUpperCase());
    });
  }
  querySelectorAll(selector: string): AnswerElement[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): AnswerElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  cloneNode(): AnswerElement { return new AnswerElement(this.tagName, { ...this.attrs }, this.text).append(...this.children.map(child => child.cloneNode())); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  getBoundingClientRect() { return { width: 100, height: 30, top: 0, left: 0 }; }
  focus() {}
  scrollIntoView() {}
  dispatchEvent(_event: Event) { return true; }
}

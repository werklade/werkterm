export function MenuBar() {
  return <nav className="menubar" aria-label="Hauptmenü">{["Terminal", "Sessions", "View", "Tools", "Help"].map(label => <span key={label} className="menu-label">{label}</span>)}</nav>;
}

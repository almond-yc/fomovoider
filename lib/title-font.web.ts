// NativeWind can't resolve platformSelect on web, so the compiled font-title
// rule is invalid CSS and browsers drop it. This gives web a real stack.
import './title-font.css';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="app-logo">
      <circle cx="16" cy="16" r="4.2" fill="currentColor" />
      <circle cx="16" cy="4.5" r="2.6" fill="currentColor" opacity="0.85" />
      <circle cx="27" cy="22.5" r="2.6" fill="currentColor" opacity="0.85" />
      <circle cx="5" cy="22.5" r="2.6" fill="currentColor" opacity="0.85" />
      <path d="M16 8.5V12.2M19 18L24.3 21M13 18L7.7 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

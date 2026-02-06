import { useState } from "react";

export function SearchBar({
  onSearch,
  inputRef,
}: {
  onSearch: (query: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSearch(value.trim());
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ position: "relative", marginBottom: 20 }}
    >
      {/* Search icon */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={focused ? "#8b5cf6" : "#8080a0"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          position: "absolute",
          left: 16,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          transition: "stroke 0.25s",
        }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>

      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Search memories..."
        style={{
          width: "100%",
          padding: "14px 16px 14px 46px",
          borderRadius: 10,
          border: `1px solid ${focused ? "rgba(139, 92, 246, 0.4)" : "#16163a"}`,
          background: focused ? "#0e0e22" : "#0c0c1d",
          color: "#e8e8f4",
          fontSize: 15,
          fontFamily: "var(--font-ui)",
          transition: "all 0.25s",
          outline: "none",
          boxShadow: focused
            ? "0 0 0 3px rgba(139, 92, 246, 0.08), 0 0 30px rgba(139, 92, 246, 0.06)"
            : "none",
        }}
      />

      {/* Bottom accent line */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "10%",
          right: "10%",
          height: 1,
          background: focused
            ? "linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.3), transparent)"
            : "transparent",
          transition: "all 0.3s",
        }}
      />
    </form>
  );
}

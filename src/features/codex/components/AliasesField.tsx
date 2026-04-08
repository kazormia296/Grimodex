import { useState, useRef } from "react";
import { Plus, X } from "lucide-react";

interface AliasesFieldProps {
  label: string;
  aliases: string[];
  onChange: (aliases: string[]) => void;
  fieldId?: string;
}

export function AliasesField({
  label,
  aliases,
  onChange,
  fieldId = "aliases",
}: AliasesFieldProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    setIsAdding(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onChange([...aliases, trimmed]);
    }
    setInputValue("");
    setIsAdding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setInputValue("");
      setIsAdding(false);
    }
  };

  const handleRemove = (index: number) => {
    onChange(aliases.filter((_, i) => i !== index));
  };

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {aliases.map((alias, index) => (
          <span
            key={index}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            {alias}
            <button
              type="button"
              data-testid={`${fieldId}-remove-${index}`}
              onClick={() => handleRemove(index)}
              className="ml-0.5 rounded-full hover:text-destructive"
              aria-label={`Remove ${alias}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {isAdding ? (
          <input
            ref={inputRef}
            data-testid={`${fieldId}-input`}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSubmit}
            className="w-24 rounded border border-input bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            placeholder="別名..."
          />
        ) : (
          <button
            type="button"
            data-testid={`${fieldId}-add-button`}
            onClick={handleAdd}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

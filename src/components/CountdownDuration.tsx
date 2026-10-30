import { useId, useState } from "react";
import { Select } from "./Select";
import { NumberInput } from "./ui/input";

const presets = [1, 3, 5, 10, 15];

export function CountdownDuration({
  seconds,
  onValueChange,
}: {
  seconds: number;
  onValueChange: (seconds: number) => void;
}) {
  const id = useId();
  const [custom, setCustom] = useState(() => !presets.includes(seconds / 60));
  const value = custom || !presets.includes(seconds / 60) ? "custom" : String(seconds / 60);

  return (
    <div className="countdown-duration-field">
      <label className="field-label" htmlFor={id}>
        Duração
      </label>
      <Select
        id={id}
        label="Duração da contagem"
        data-testid="countdown-duration"
        value={value}
        onValueChange={(next) => {
          setCustom(next === "custom");
          if (next !== "custom") onValueChange(Number(next) * 60);
        }}
        options={[
          ...presets.map((minutes) => ({
            value: String(minutes),
            label: minutes === 1 ? "1 minuto" : `${minutes} minutos`,
          })),
          { value: "custom", label: "Personalizada" },
        ]}
      />
      {value === "custom" && (
        <label className="field-label custom-duration-field">
          Quantos minutos?
          <div className="custom-duration-input">
            <NumberInput
              label="Duração personalizada em minutos"
              data-testid="countdown-custom-minutes"
              min={0}
              max={1440}
              step="any"
              value={Number((seconds / 60).toFixed(6))}
              onValueChange={(minutes) => onValueChange(Math.round(minutes * 60))}
            />
            <span aria-hidden="true">min</span>
          </div>
        </label>
      )}
    </div>
  );
}

import { useRef, useState, type ComponentPropsWithoutRef } from 'react';
import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import './Select.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentPropsWithoutRef<typeof Primitive.Trigger>, 'value' | 'onChange' | 'children'> {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label?: string;
  placeholder?: string;
  name?: string;
  required?: boolean;
  'data-testid'?: string;
}

/** A keyboard-accessible, consistently styled replacement for a native select. */
export function Select({ value, onValueChange, options, label, placeholder = 'Selecionar', disabled, name, required, className = '', ...triggerProps }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement>();
  // Radix reserves an empty item value. Stable option indices let device menus
  // retain the application's empty-string value for the default device.
  const selectedIndex = options.findIndex(option => option.value === value);
  const token = (index: number) => `option-${index}`;

  return (
    <Primitive.Root
      value={selectedIndex < 0 ? '' : token(selectedIndex)}
      onValueChange={next => {
        const option = options[Number(next.slice('option-'.length))];
        if (option) onValueChange(option.value);
      }}
      open={open}
      onOpenChange={next => {
        if (next) setContainer(trigger.current?.closest<HTMLElement>('.studio-modal') ?? undefined);
        setOpen(next);
      }}
      disabled={disabled}
      required={required}
    >
      <Primitive.Trigger
        {...triggerProps}
        ref={trigger}
        type="button"
        data-value={value}
        aria-label={label ?? triggerProps['aria-label']}
        className={`gs-select-trigger ${className}`}
      >
        <Primitive.Value placeholder={placeholder} />
        <Primitive.Icon className="gs-select-chevron"><ChevronDown size={14} /></Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content className="gs-select-content" position="popper" sideOffset={6} collisionPadding={12} align="start">
          <Primitive.ScrollUpButton className="gs-select-scroll"><ChevronUp size={13} /></Primitive.ScrollUpButton>
          <Primitive.Viewport className="gs-select-viewport">
            {options.map((option, index) => (
              <Primitive.Item key={option.value} value={token(index)} data-value={option.value} disabled={option.disabled} textValue={option.label} className="gs-select-item">
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                <Primitive.ItemIndicator className="gs-select-check"><Check size={14} /></Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="gs-select-scroll"><ChevronDown size={13} /></Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    </Primitive.Root>
  );
}

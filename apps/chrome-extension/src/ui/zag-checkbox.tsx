import { normalizeProps, useMachine } from '@zag-js/preact'
import * as checkbox from '@zag-js/checkbox'
import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

type UseZagCheckboxArgs = {
  id: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

export function useZagCheckbox({ id, checked, disabled, onCheckedChange }: UseZagCheckboxArgs) {
  const syncing = useRef(false)

  const service = useMachine(checkbox.machine, {
    id,
    checked,
    disabled,
    onCheckedChange: ({ checked: next }: checkbox.CheckedChangeDetails) => {
      if (syncing.current) return
      onCheckedChange(Boolean(next))
    },
  })

  const api = checkbox.connect(service, normalizeProps)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    if (apiRef.current.checked === checked) return
    syncing.current = true
    apiRef.current.setChecked(checked)
    queueMicrotask(() => {
      syncing.current = false
    })
  }, [checked])

  return api
}

function Checkmark() {
  return (
    <svg viewBox="0 0 16 12" aria-hidden="true">
      <path d="M2 6.5 6 10l8-8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function CheckboxField({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const api = useZagCheckbox({ id, checked, disabled, onCheckedChange })
  const rootProps = api.getRootProps()
  const controlProps = api.getControlProps()
  const indicatorProps = api.getIndicatorProps()
  const labelProps = api.getLabelProps()
  const { className: rootClassName, ...rootRest } = rootProps
  const { className: controlClassName, ...controlRest } = controlProps
  const { className: indicatorClassName, ...indicatorRest } = indicatorProps
  const { className: labelClassName, ...labelRest } = labelProps
  return (
    <label className={`checkboxRoot ${rootClassName ?? ''}`.trim()} {...rootRest}>
      <span className={`checkboxControl ${controlClassName ?? ''}`.trim()} {...controlRest}>
        <span className={`checkboxIndicator ${indicatorClassName ?? ''}`.trim()} {...indicatorRest}>
          <Checkmark />
        </span>
      </span>
      <span className={`checkboxLabel ${labelClassName ?? ''}`.trim()} {...labelRest}>
        {label}
      </span>
      <input {...api.getHiddenInputProps()} />
    </label>
  )
}

export function mountCheckbox(
  root: HTMLElement,
  props: {
    id: string
    label: string
    checked: boolean
    disabled?: boolean
    onCheckedChange: (checked: boolean) => void
  }
) {
  let current = props
  const renderCheckbox = () => {
    render(<CheckboxField {...current} />, root)
  }

  renderCheckbox()

  return {
    update(next: typeof current) {
      current = next
      renderCheckbox()
    },
  }
}

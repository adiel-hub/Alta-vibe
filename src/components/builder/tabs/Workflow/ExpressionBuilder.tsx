"use client";

/**
 * Recursive editor for an `expression` edge condition — full parity with
 * ElevenLabs' AstNodeInput. Every node carries a "kind" selector; operands are
 * themselves nodes (free placement), so any tree the API accepts is buildable:
 * variables, literals (text/number/boolean/null), the `llm` operand,
 * comparisons (=,≠,>,≥,<,≤), arithmetic (+,−,×,÷), AND/OR groups (n-ary), and
 * the ternary conditional (if/then/else). Values round-trip verbatim.
 */
import type { WorkflowAstNode } from "@/types/agent";

type Kind = WorkflowAstNode["type"];

const KIND_GROUPS: { group: string; items: { value: Kind; label: string }[] }[] = [
  {
    group: "Value",
    items: [
      { value: "dynamic_variable", label: "Variable" },
      { value: "string_literal", label: "Text" },
      { value: "number_literal", label: "Number" },
      { value: "boolean_literal", label: "Boolean" },
      { value: "null_literal", label: "Null" },
      { value: "llm", label: "LLM eval" },
    ],
  },
  {
    group: "Compare",
    items: [
      { value: "eq_operator", label: "= equals" },
      { value: "neq_operator", label: "≠ not equals" },
      { value: "gt_operator", label: "> greater" },
      { value: "gte_operator", label: "≥ greater or equal" },
      { value: "lt_operator", label: "< less" },
      { value: "lte_operator", label: "≤ less or equal" },
    ],
  },
  {
    group: "Math",
    items: [
      { value: "add_operator", label: "+ add" },
      { value: "sub_operator", label: "− subtract" },
      { value: "mul_operator", label: "× multiply" },
      { value: "div_operator", label: "÷ divide" },
    ],
  },
  {
    group: "Logic",
    items: [
      { value: "and_operator", label: "AND (all of)" },
      { value: "or_operator", label: "OR (any of)" },
    ],
  },
  {
    group: "Conditional",
    items: [{ value: "conditional_operator", label: "If / then / else" }],
  },
];

const BINARY = new Set<Kind>([
  "eq_operator",
  "neq_operator",
  "gt_operator",
  "gte_operator",
  "lt_operator",
  "lte_operator",
  "add_operator",
  "sub_operator",
  "mul_operator",
  "div_operator",
]);
const GROUP = new Set<Kind>(["and_operator", "or_operator"]);

const leaf = (): WorkflowAstNode => ({ type: "dynamic_variable", name: "" });

export function emptyComparison(): WorkflowAstNode {
  return {
    type: "eq_operator",
    left: { type: "dynamic_variable", name: "" },
    right: { type: "string_literal", value: "" },
  };
}

const has = <K extends string>(o: object, k: K): o is Record<K, WorkflowAstNode> =>
  k in o;

/** Morph a node to a new kind, preserving operands where the shapes line up. */
function morph(node: WorkflowAstNode, type: Kind): WorkflowAstNode {
  if (BINARY.has(type)) {
    const left = has(node, "left") ? node.left : has(node, "condition") ? node.condition : leaf();
    const right = has(node, "right") ? node.right : leaf();
    return { type, left, right } as WorkflowAstNode;
  }
  if (GROUP.has(type)) {
    const children =
      "children" in node && Array.isArray(node.children)
        ? node.children
        : has(node, "left")
          ? [node.left, node.right]
          : [leaf(), leaf()];
    return { type, children: children.length ? children : [leaf(), leaf()] } as WorkflowAstNode;
  }
  if (type === "conditional_operator") {
    return {
      type,
      condition: has(node, "condition") ? node.condition : has(node, "left") ? node.left : leaf(),
      trueExpression: has(node, "trueExpression") ? node.trueExpression : leaf(),
      falseExpression: has(node, "falseExpression") ? node.falseExpression : leaf(),
    };
  }
  switch (type) {
    case "dynamic_variable":
      return { type, name: node.type === "dynamic_variable" ? node.name : "" };
    case "string_literal":
      return { type, value: node.type === "string_literal" ? node.value : "" };
    case "number_literal":
      return { type, value: node.type === "number_literal" ? node.value : 0 };
    case "boolean_literal":
      return { type, value: node.type === "boolean_literal" ? node.value : true };
    case "null_literal":
      return { type };
    case "llm":
      return { type, value: node.type === "llm" ? node.value : { prompt: "" } };
    default:
      return leaf();
  }
}

function KindSelect({
  value,
  onChange,
}: {
  value: Kind;
  onChange: (k: Kind) => void;
}) {
  return (
    <select
      className="vb-field-input vb-expr-kind-select"
      value={value}
      onChange={(e) => onChange(e.target.value as Kind)}
      aria-label="Node type"
    >
      {KIND_GROUPS.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((it) => (
            <option key={it.value} value={it.value}>
              {it.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Operand({
  label,
  node,
  onChange,
}: {
  label: string;
  node: WorkflowAstNode;
  onChange: (n: WorkflowAstNode) => void;
}) {
  return (
    <div className="vb-expr-operand">
      <span className="vb-expr-operand-label">{label}</span>
      <NodeEditor node={node} onChange={onChange} />
    </div>
  );
}

function NodeEditor({
  node,
  onChange,
  onRemove,
}: {
  node: WorkflowAstNode;
  onChange: (n: WorkflowAstNode) => void;
  onRemove?: () => void;
}) {
  const inline =
    node.type === "dynamic_variable" ||
    node.type === "string_literal" ||
    node.type === "number_literal" ||
    node.type === "boolean_literal" ||
    node.type === "null_literal";

  return (
    <div className={`vb-expr-node ${inline ? "is-inline" : ""}`}>
      <div className="vb-expr-node-head">
        <KindSelect value={node.type} onChange={(k) => onChange(morph(node, k))} />

        {/* Leaf value editors render inline next to the kind selector. */}
        {node.type === "dynamic_variable" && (
          <div className="vb-expr-var">
            <span className="vb-expr-var-icon" aria-hidden>
              (x)
            </span>
            <input
              dir="auto"
              className="vb-field-input"
              value={node.name}
              placeholder="variable name"
              onChange={(e) => onChange({ type: "dynamic_variable", name: e.target.value })}
            />
          </div>
        )}
        {node.type === "string_literal" && (
          <input
            dir="auto"
            className="vb-field-input"
            value={node.value}
            placeholder="text value"
            onChange={(e) => onChange({ type: "string_literal", value: e.target.value })}
          />
        )}
        {node.type === "number_literal" && (
          <input
            type="number"
            className="vb-field-input"
            value={node.value}
            onChange={(e) =>
              onChange({ type: "number_literal", value: Number(e.target.value) || 0 })
            }
          />
        )}
        {node.type === "boolean_literal" && (
          <select
            className="vb-field-input"
            value={node.value ? "true" : "false"}
            onChange={(e) => onChange({ type: "boolean_literal", value: e.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        )}
        {node.type === "null_literal" && (
          <span className="vb-expr-null">null</span>
        )}

        {onRemove && (
          <button
            type="button"
            className="vb-expr-remove"
            onClick={onRemove}
            aria-label="Remove node"
          >
            ✕
          </button>
        )}
      </div>

      {/* Composite bodies */}
      {node.type === "llm" && <LlmEditor node={node} onChange={onChange} />}

      {BINARY.has(node.type) && "left" in node && (
        <div className="vb-expr-operands">
          <Operand label="left" node={node.left} onChange={(left) => onChange({ ...node, left })} />
          <Operand
            label="right"
            node={node.right}
            onChange={(right) => onChange({ ...node, right })}
          />
        </div>
      )}

      {GROUP.has(node.type) && "children" in node && (
        <div className="vb-expr-operands">
          <div className="vb-expr-children">
            {node.children.map((c, i) => (
              <NodeEditor
                key={i}
                node={c}
                onChange={(nc) =>
                  onChange({ ...node, children: node.children.map((x, j) => (j === i ? nc : x)) })
                }
                onRemove={
                  node.children.length > 1
                    ? () => onChange({ ...node, children: node.children.filter((_, j) => j !== i) })
                    : undefined
                }
              />
            ))}
          </div>
          <button
            type="button"
            className="vb-expr-add"
            onClick={() => onChange({ ...node, children: [...node.children, emptyComparison()] })}
          >
            + Add condition
          </button>
        </div>
      )}

      {node.type === "conditional_operator" && "condition" in node && (
        <div className="vb-expr-operands">
          <Operand
            label="if"
            node={node.condition}
            onChange={(condition) => onChange({ ...node, condition })}
          />
          <Operand
            label="then"
            node={node.trueExpression}
            onChange={(trueExpression) => onChange({ ...node, trueExpression })}
          />
          <Operand
            label="else"
            node={node.falseExpression}
            onChange={(falseExpression) => onChange({ ...node, falseExpression })}
          />
        </div>
      )}
    </div>
  );
}

function LlmEditor({
  node,
  onChange,
}: {
  node: Extract<WorkflowAstNode, { type: "llm" }>;
  onChange: (n: WorkflowAstNode) => void;
}) {
  const mode = "valueSchema" in node.value ? "schema" : "prompt";
  return (
    <div className="vb-expr-operands">
      <select
        className="vb-field-input vb-expr-kind-select"
        value={mode}
        onChange={(e) =>
          onChange({
            type: "llm",
            value:
              e.target.value === "schema"
                ? { valueSchema: {} }
                : { prompt: "" },
          })
        }
      >
        <option value="prompt">Boolean prompt</option>
        <option value="schema">JSON schema</option>
      </select>
      {"prompt" in node.value ? (
        <textarea
          dir="auto"
          rows={2}
          className="vb-field-input vb-field-textarea"
          value={node.value.prompt}
          placeholder="prompt the LLM evaluates to true/false"
          onChange={(e) => onChange({ type: "llm", value: { prompt: e.target.value } })}
        />
      ) : (
        <textarea
          className="vb-field-input vb-field-textarea"
          rows={3}
          value={JSON.stringify(node.value.valueSchema ?? {}, null, 2)}
          onChange={(e) => {
            try {
              const valueSchema = JSON.parse(e.target.value);
              onChange({ type: "llm", value: { valueSchema } });
            } catch {
              /* keep typing; ignore invalid JSON until it parses */
            }
          }}
        />
      )}
    </div>
  );
}

export function ExpressionBuilder({
  value,
  onChange,
}: {
  value: WorkflowAstNode;
  onChange: (n: WorkflowAstNode) => void;
}) {
  return (
    <div className="vb-expr-root">
      <NodeEditor node={value} onChange={onChange} />
    </div>
  );
}

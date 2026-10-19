// The sitting's renderers: the Quote selection's quoting sentences and
// the Quoted answer's guarded document, drawn from the exact shapes the
// server settles (ADR-0020) — quote parts visibly apart, page labels at
// the paragraph's end, citations listed beneath.
import { StyleSheet, Text, View } from "react-native";
import type { Block, Palette, QuotePart, Selection, Source } from "./types";
import { S } from "./strings";

export function QuoteSpan({
  text,
  palette,
}: {
  text: string;
  palette: Palette;
}) {
  // The resting clay highlight: the Book's own words, never the app's.
  return (
    <Text style={[styles.quote, { backgroundColor: palette.gold + "2b", color: palette.ink }]}>
      {text}
    </Text>
  );
}

export function ParagraphParts({ parts, palette }: { parts: QuotePart[]; palette: Palette }) {
  const labels: string[] = [];
  for (const part of parts) {
    if (part.pages_label && !labels.includes(part.pages_label)) {
      labels.push(part.pages_label);
    }
  }
  return (
    <Text style={[styles.para, { color: palette.ink }]}>
      {parts.map((part, index) =>
        part.quote !== undefined ? (
          <QuoteSpan key={index} text={part.quote} palette={palette} />
        ) : (
          <Text key={index}>{part.text} </Text>
        )
      )}
      {labels.map((label) => (
        <Text key={label} style={[styles.pages, { color: palette.mute }]}>
          {" "}
          [{label}]
        </Text>
      ))}
    </Text>
  );
}

export function Blocks({ blocks, palette }: { blocks: Block[]; palette: Palette }) {
  return (
    <View>
      {blocks.map((block, index) =>
        block.type === "heading" ? (
          <Text key={index} style={[styles.heading, { color: palette.clay }]}>
            {block.text}
          </Text>
        ) : (
          <ParagraphParts key={index} parts={block.parts ?? []} palette={palette} />
        )
      )}
    </View>
  );
}

export function SelectionList({
  selections,
  palette,
}: {
  selections: Selection[];
  palette: Palette;
}) {
  return (
    <View>
      {selections.map((item, index) => (
        <Text key={index} style={[styles.para, { color: palette.ink }]}>
          <QuoteSpan text={item.text} palette={palette} />
          {item.pages_label ? (
            <Text style={[styles.pages, { color: palette.mute }]}> [{item.pages_label}]</Text>
          ) : null}
        </Text>
      ))}
    </View>
  );
}

export function PoolList({ sources, palette }: { sources: Source[]; palette: Palette }) {
  return (
    <View>
      {sources.map((source, index) => (
        <View key={index} style={styles.poolRow}>
          <Text style={[styles.poolRef, { color: palette.mute }]}>{source.reference}</Text>
          <Text style={[styles.para, { color: palette.ink }]}>{source.passage}</Text>
        </View>
      ))}
    </View>
  );
}

export function References({ items, palette }: { items: string[]; palette: Palette }) {
  return (
    <View style={styles.references}>
      <Text style={[styles.heading, { color: palette.clay }]}>{S.references}</Text>
      {items.map((item, index) => (
        <Text key={index} style={[styles.poolRef, { color: palette.mute }]}>
          {item}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  para: {
    fontSize: 15,
    lineHeight: 28,
    textAlign: "right",
    marginTop: 6,
  },
  quote: {
    fontSize: 15,
    lineHeight: 28,
    textAlign: "right",
  },
  pages: {
    fontSize: 13,
  },
  heading: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 4,
    textAlign: "right",
  },
  poolRow: {
    marginTop: 8,
  },
  poolRef: {
    fontSize: 12,
    textAlign: "right",
  },
  references: {
    marginTop: 12,
  },
});

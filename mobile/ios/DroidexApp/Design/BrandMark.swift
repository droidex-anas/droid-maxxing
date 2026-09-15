import SwiftUI

// A vector pixel wordmark keeps the desktop identity without bundling a font.
struct BrandMark: View {
    var body: some View {
        PixelWordmark()
            .fill(DroidTheme.text)
            .aspectRatio(41.0 / 5.0, contentMode: .fit)
            .accessibilityLabel("DROIDEX")
            .accessibilityAddTraits(.isImage)
    }
}

private struct PixelWordmark: Shape {
    private let letters = [
        ["11110", "10001", "10001", "10001", "11110"],
        ["11110", "10001", "11110", "10100", "10010"],
        ["01110", "10001", "10001", "10001", "01110"],
        ["11111", "00100", "00100", "00100", "11111"],
        ["11110", "10001", "10001", "10001", "11110"],
        ["11111", "10000", "11110", "10000", "11111"],
        ["10001", "01010", "00100", "01010", "10001"]
    ]

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width / 41, rect.height / 5)
        var path = Path()
        for (letterIndex, rows) in letters.enumerated() {
            for (row, pixels) in rows.enumerated() {
                for (column, pixel) in pixels.enumerated() where pixel == "1" {
                    path.addRect(CGRect(
                        x: rect.minX + CGFloat(letterIndex * 6 + column) * unit,
                        y: rect.minY + CGFloat(row) * unit, width: unit, height: unit
                    ))
                }
            }
        }
        return path
    }
}

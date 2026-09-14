// 生成 RAMap 应用图标：等距地图格 + 矿石，与编辑器画布同一套配色。
//   swift icon/generate.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let CANVAS: CGFloat = 1024
let BODY: CGFloat = 824
let INSET: CGFloat = (CANVAS - BODY) / 2
let RADIUS: CGFloat = BODY * 0.225

func hex(_ v: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255, alpha: a)
}

let context = CGContext(data: nil, width: Int(CANVAS), height: Int(CANVAS), bitsPerComponent: 8,
                        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// 底：深色圆角矩形，自下而上提亮
let body = CGRect(x: INSET, y: INSET, width: BODY, height: BODY)
context.saveGState()
context.addPath(CGPath(roundedRect: body, cornerWidth: RADIUS, cornerHeight: RADIUS, transform: nil))
context.clip()
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let gradient = CGGradient(colorsSpace: space, colors: [hex(0x2E3A49), hex(0x141A22)] as CFArray, locations: [0, 1])!
context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: CANVAS), end: CGPoint(x: 0, y: 0), options: [])

// 等距格子：菱形宽 2 高 1，和编辑器里 24×12 的格子同比例
let cellWidth: CGFloat = 132
let cellHeight = cellWidth / 2
let size = 5
let center = CGPoint(x: CANVAS / 2, y: CANVAS / 2 + cellHeight * 0.4)
// 矿石与宝石落点，其余是地面
let ore: Set<[Int]> = [[1, 1], [2, 1], [1, 2], [3, 2], [2, 3]]
let gems: Set<[Int]> = [[3, 3]]

func diamond(_ cx: CGFloat, _ cy: CGFloat) -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: cx, y: cy + cellHeight / 2))
    path.addLine(to: CGPoint(x: cx + cellWidth / 2, y: cy))
    path.addLine(to: CGPoint(x: cx, y: cy - cellHeight / 2))
    path.addLine(to: CGPoint(x: cx - cellWidth / 2, y: cy))
    path.closeSubpath()
    return path
}

for row in 0..<size {
    for col in 0..<size {
        let cx = center.x + CGFloat(col - row) * cellWidth / 2
        let cy = center.y - CGFloat(col + row - size + 1) * cellHeight / 2
        let key = [col, row]
        let fill = ore.contains(key) ? hex(0xE8CB27) : gems.contains(key) ? hex(0xB650D7) : hex(0x6E7C74)
        // 侧面：给每格一点厚度，读出高度
        let side = CGMutablePath()
        side.addPath(diamond(cx, cy - 22))
        context.addPath(side)
        context.setFillColor(hex(0x0E1319, 0.55))
        context.fillPath()
        context.addPath(diamond(cx, cy))
        context.setFillColor(fill)
        context.fillPath()
        context.addPath(diamond(cx, cy))
        context.setStrokeColor(hex(0x0E1319, 0.45))
        context.setLineWidth(3)
        context.strokePath()
    }
}
context.restoreGState()

let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("icon/source-1024.png")
let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
CGImageDestinationFinalize(destination)
print("✓ icon/source-1024.png")

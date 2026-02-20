import { Workspace } from "@rbxts/services"
import CoreGui from "./CoreGui"

export interface HighlightOptions {
    Name?: string
    FillColor?: Color3
    DepthMode?: Enum.HighlightDepthMode
    FillTransparency?: number
    OutlineColor?: Color3
    OutlineTransparency?: number
    Parent?: Instance
}

export class Highlighter {
    public highlight!: Highlight

    private static getStorage(): Folder {
        let storage = CoreGui.FindFirstChild("HighlightStorage")

        if (!storage || !storage.IsA("Folder")) {
            storage?.Destroy()
            const folder = new Instance("Folder")
            folder.Name = "HighlightStorage"
            folder.Parent = CoreGui
            storage = folder
        }

        return storage as Folder
    }

    public constructor(target: Instance, options?: HighlightOptions) {
        const highlighterStorage = Highlighter.getStorage()

        highlighterStorage.GetChildren().forEach((child) => {
            if (child.IsA("Highlight") && child.Adornee === target) {
                warn("trying to highlight already highlighted object")
                return
            }
        })

        // confusing asl but we gotta work with it
        const _highlight = new Instance("Highlight")
        _highlight.Name = options?.Name ?? "Highlight"
        _highlight.FillColor =
            options?.FillColor ?? Color3.fromRGB(59, 235, 223)
        _highlight.DepthMode =
            options?.DepthMode ?? Enum.HighlightDepthMode.AlwaysOnTop
        _highlight.FillTransparency = options?.FillTransparency ?? 0.5
        _highlight.OutlineColor =
            options?.OutlineColor ?? Color3.fromRGB(255, 255, 255)
        _highlight.OutlineTransparency = options?.OutlineTransparency ?? 0
        _highlight.Parent = options?.Parent ?? highlighterStorage
        _highlight.Adornee = target

        this.highlight = _highlight
    }

    public destroy() {
        this.highlight.Destroy()
    }

    // Preserve backwards compatibility with older callsites.
    public destory() {
        this.destroy()
    }

    public static destroyAll() {
        const storage = CoreGui.FindFirstChild("HighlightStorage")

        if (storage?.IsA("Folder")) {
            storage.GetChildren().forEach((child) => child.Destroy())
        }

        // Cleanup legacy highlights previously created outside HighlightStorage.
        Workspace.FindFirstChild("Board")
            ?.GetDescendants()
            .forEach((descendant) => {
                if (descendant.IsA("Highlight")) descendant.Destroy()
            })

        Workspace.FindFirstChild("Pieces")
            ?.GetDescendants()
            .forEach((descendant) => {
                if (descendant.IsA("Highlight")) descendant.Destroy()
            })
    }
}

import { ReplicatedStorage } from "@rbxts/services"

export = () => {
    const connections = ReplicatedStorage.FindFirstChild("Connections")

    if (!connections || !connections.IsA("Folder")) {
        return
    }

    const clientError = connections.FindFirstChild("ReportClientError")
    clientError?.Destroy()
}

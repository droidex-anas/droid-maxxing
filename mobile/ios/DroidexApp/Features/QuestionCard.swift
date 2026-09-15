import DroidexCore
import SwiftUI

struct QuestionCard: View {
    @Environment(SessionStore.self) private var store
    let question: RemoteQuestion
    let sessionID: UUID
    @State private var answers: [Int: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("DROIDEX needs your input").font(.headline)
            ForEach(question.questions, id: \.index) { item in
                VStack(alignment: .leading, spacing: 10) {
                    Text(item.question).font(.callout)
                    if !item.options.isEmpty {
                        ForEach(item.options, id: \.self) { option in
                            Button(option) { answers[item.index] = option }
                                .buttonStyle(.bordered)
                                .accessibilityAddTraits(answers[item.index] == option ? .isSelected : [])
                        }
                    }
                    TextField("Your answer", text: Binding(get: { answers[item.index] ?? "" }, set: { answers[item.index] = $0 }), axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(1...5)
                }
            }
            Button("Send answer") {
                store.answer(question.id, in: sessionID, answers: question.questions.map { answers[$0.index] ?? "" })
            }
            .buttonStyle(.borderedProminent).tint(DroidTheme.text).foregroundStyle(DroidTheme.background)
            .disabled(!store.canSend || question.questions.contains { answers[$0.index]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false })
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(DroidTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }
}

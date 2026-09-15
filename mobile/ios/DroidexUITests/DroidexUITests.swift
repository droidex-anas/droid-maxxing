import XCTest

final class DroidexUITests: XCTestCase {
    @MainActor
    func testSeededSessionCanBeReviewedAndApproved() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let session = app.staticTexts["Refine the mobile composer"]
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        session.tap()
        let review = app.buttons["review.open"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        if !review.isHittable { app.swipeUp() }
        review.tap()
        let approve = app.buttons["approval.allow"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        for _ in 0..<4 where !approve.isHittable { app.swipeUp() }
        approve.tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: approve)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 5), .completed)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Reviewed sample patch"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testNewSessionCanStartAndStop() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        let compose = app.buttons["inbox.compose"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        compose.tap()
        let prompt = app.descendants(matching: .any).matching(identifier: "new-session.prompt").firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Make the mobile composer feel native")
        app.buttons["new-session.start"].tap()
        let stop = app.buttons["composer.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Stopped"].exists)
    }
}

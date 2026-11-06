package acme

import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.module() {
    routing {
        get("/kt/health") { call.respondText("ok") }
        route("/kt/users") {
            get { call.respondText("[]") }
            post("/{id}") { call.respondText("created") }
        }
    }
}
